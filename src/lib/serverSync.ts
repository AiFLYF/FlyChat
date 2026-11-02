import type { Conversation } from '../types'
import { deleteConversationFromServer, syncConversationToServer } from '../api/client'

/**
 * 会话同步的重试队列。
 *
 * 服务端 SQLite 是本地 IndexedDB 的副本，同步失败原本会被静默吞掉：
 * 网络抖一下，这次对话就永远只存在于当前浏览器里。
 * 这里做一个轻量 outbox：
 * - 同一会话只保留最新快照（版本号判断，避免旧快照覆盖新快照）
 * - 网络错误 / 5xx / 429 按指数退避重试（上限 60s），4xx 直接放弃
 * - `online` 与页面重新可见时立即冲刷，不用等退避计时
 * - 待办 id 按存储作用域（单用户 / 每个账号）写入 localStorage，刷新后继续补发；
 *   切换身份时清空内存队列，绝不能把上一个账号的会话以新身份发出去
 * - 清空 / 替换本地数据前必须 resetServerSyncQueue：把排队的待办全部取消，
 *   并等在途请求结束，否则清空后旧任务会把会话重新写回服务端
 */

interface SyncJob {
  conv: Conversation
  version: number
  attempts: number
  running: boolean
  timer?: ReturnType<typeof setTimeout>
}

interface DeleteJob {
  attempts: number
  timer?: ReturnType<typeof setTimeout>
}

const BASE_DELAY = 2000
const MAX_DELAY = 60000
const MAX_PENDING_IDS = 500
const syncJobs = new Map<string, SyncJob>()
const deleteJobs = new Map<string, DeleteJob>()
const inflight = new Set<Promise<void>>()
let listening = false
let scope = 'flychat-store'

/** 记录在途请求，resetServerSyncQueue 要等它们落地后再让调用方清服务端 */
function track(promise: Promise<void>): void {
  inflight.add(promise)
  void promise
    .finally(() => {
      inflight.delete(promise)
    })
    .catch(() => {})
}

function storageKey(): string {
  return `flychat-pending-sync:${scope}`
}

function isGuest(): boolean {
  return scope === 'flychat-guest'
}

/** 只存 id，不存会话正文：正文本来就在 IndexedDB 里，重复存一份既大又容易过期 */
function persistPending(): void {
  if (typeof localStorage === 'undefined' || isGuest()) return
  try {
    localStorage.setItem(
      storageKey(),
      JSON.stringify({
        conversations: [...syncJobs.keys()].slice(0, MAX_PENDING_IDS),
        deletes: [...deleteJobs.keys()].slice(0, MAX_PENDING_IDS),
      })
    )
  } catch {
    // 存储不可用不影响当前会话继续重试
  }
}

function readPending(): { conversations: string[]; deletes: string[] } {
  if (typeof localStorage === 'undefined' || isGuest()) return { conversations: [], deletes: [] }
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey()) || 'null')
    const clean = (list: unknown): string[] =>
      Array.isArray(list)
        ? list.filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200).slice(0, MAX_PENDING_IDS)
        : []
    return { conversations: clean(parsed?.conversations), deletes: clean(parsed?.deletes) }
  } catch {
    return { conversations: [], deletes: [] }
  }
}

/** 身份切换时调用。旧账号的待办已经按旧作用域落盘，换回来后由 resumePendingSyncs 补发；
 * 这里必须清空内存，否则会用新身份的 cookie 去写别人的会话（服务端会 404，但没必要发）。
 */
export function setServerSyncScope(name: string): void {
  if (name === scope) return
  scope = name
  dropAllJobs()
}

/**
 * 清空 / 替换本地数据前调用：取消所有排队与退避中的任务，并等在途请求结束。
 * 调用方接着清服务端，删除才会排在最后生效；否则旧的同步请求会在清空后把会话写回去。
 */
export async function resetServerSyncQueue(): Promise<void> {
  dropAllJobs()
  persistPending()
  await Promise.allSettled([...inflight])
}

function dropAllJobs(): void {
  for (const job of syncJobs.values()) {
    if (job.timer) clearTimeout(job.timer)
  }
  syncJobs.clear()
  for (const job of deleteJobs.values()) {
    if (job.timer) clearTimeout(job.timer)
  }
  deleteJobs.clear()
}

/** 本地数据恢复完成后调用：把刷新前没发完的待办重新排队 */
export function resumePendingSyncs(getConversation: (id: string) => Conversation | undefined): void {
  ensureListeners()
  const pending = readPending()
  for (const id of pending.deletes) queueConversationDelete(id)
  for (const id of pending.conversations) {
    const conv = getConversation(id)
    // 本地已经没有这条会话（用户删了/换了设备）就丢弃，不再无意义地重试
    if (conv) queueConversationSync(conv)
  }
  persistPending()
}

function ensureListeners(): void {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('online', flushAll)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') flushAll()
  })
}

function retryDelay(attempts: number): number {
  return Math.min(MAX_DELAY, BASE_DELAY * 2 ** Math.max(0, attempts - 1)) + Math.floor(Math.random() * 300)
}

/** 网络恢复 / 页面重新可见时立即重试所有待办，不等退避计时 */
export function flushAll(): void {
  for (const [id, job] of syncJobs) {
    if (job.running) continue
    if (job.timer) {
      clearTimeout(job.timer)
      job.timer = undefined
    }
    track(runSync(id))
  }
  for (const [id, job] of deleteJobs) {
    if (job.timer) {
      clearTimeout(job.timer)
      job.timer = undefined
    }
    track(runDelete(id))
  }
}

export function queueConversationSync(conv: Conversation): void {
  ensureListeners()
  // 同一会话刚被本地删除：不要让排队中的同步把它重新写回服务端
  if (deleteJobs.has(conv.id)) return
  const existing = syncJobs.get(conv.id)
  if (existing) {
    existing.conv = conv
    existing.version += 1
    return
  }
  const job: SyncJob = { conv, version: 1, attempts: 0, running: false }
  syncJobs.set(conv.id, job)
  persistPending()
  track(runSync(conv.id))
}

export function queueConversationDelete(id: string): void {
  ensureListeners()
  const pending = syncJobs.get(id)
  if (pending) {
    if (pending.timer) clearTimeout(pending.timer)
    syncJobs.delete(id)
  }
  if (deleteJobs.has(id)) return
  const job: DeleteJob = { attempts: 0 }
  deleteJobs.set(id, job)
  persistPending()
  track(runDelete(id))
}

/**
 * 撤销删除：取消排队中的删除任务，再重新同步这条会话。
 * 删除请求可能已经发出去，必须等它落地后再上传，否则 DELETE 后到的顺序会把会话删掉。
 */
export async function restoreConversationSync(conv: Conversation): Promise<void> {
  const job = deleteJobs.get(conv.id)
  if (job) {
    if (job.timer) clearTimeout(job.timer)
    deleteJobs.delete(conv.id)
    persistPending()
    await Promise.allSettled([...inflight])
  }
  queueConversationSync(conv)
}

async function runSync(id: string): Promise<void> {
  const job = syncJobs.get(id)
  if (!job || job.running) return
  job.running = true
  const sentVersion = job.version
  const result = await syncConversationToServer(job.conv)
  job.running = false
  if (syncJobs.get(id) !== job) return

  if (result.ok) {
    job.attempts = 0
    // 请求期间又来了新快照：立刻补一次，别把最后一轮内容丢了
    if (job.version > sentVersion) {
      track(runSync(id))
      return
    }
    syncJobs.delete(id)
    persistPending()
    return
  }
  if (!result.retryable) {
    syncJobs.delete(id)
    persistPending()
    return
  }
  job.attempts += 1
  job.timer = setTimeout(() => {
    job.timer = undefined
    track(runSync(id))
  }, retryDelay(job.attempts))
}

async function runDelete(id: string): Promise<void> {
  const job = deleteJobs.get(id)
  if (!job) return
  const result = await deleteConversationFromServer(id)
  if (deleteJobs.get(id) !== job) return
  if (result.ok || !result.retryable) {
    deleteJobs.delete(id)
    persistPending()
    return
  }
  job.attempts += 1
  job.timer = setTimeout(() => {
    job.timer = undefined
    track(runDelete(id))
  }, retryDelay(job.attempts))
}
