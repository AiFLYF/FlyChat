import { get, set, del, keys, clear, createStore } from 'idb-keyval'

/**
 * zustand persist 的 IndexedDB 存储适配器。
 * 相比 localStorage 的 5MB 上限，IndexedDB 可存放大量会话与附件。
 * 首次读取时会自动把旧的 localStorage 数据迁移过来（同名 key）。
 *
 * 附件治理（避免本地存储膨胀）：
 * 图片以 base64 dataUrl 嵌在每条消息里，多图长会话会让整份会话状态撑成一条超大
 * 记录，备份 JSON 也会异常臃肿。这里把图片 blob 外置到独立的 IndexedDB 库
 * （flychat-attachments），主 store 只保留元数据 + externalized 标记；读取时再把
 * dataUrl 重新内联，保证渲染与发送给模型都不缺数据。persist 时还会顺手清理已删除
 * 附件留下的孤儿 blob。
 *
 * 流式写入节流：
 * 长会话流式生成时每个 token 都会更新 zustand 状态并触发 persist 写整份 store，
 * 高频序列化 + IndexedDB 写入会造成输入卡顿、拖慢长回复。流式期间调用 pausePersist
 * 暂停落盘，只保留最后一次完整状态，待流结束（或页面卸载/隐藏）再一次性 flush。
 */
const attachStore = createStore('flychat-attachments', 'blobs')

type AnyRec = Record<string, any>

// 已经写入过 blob 的附件 id，避免每次 persist 都重写同一份 base64
const savedBlobIds = new Set<string>()

async function saveBlob(id: string, dataUrl: string): Promise<void> {
  await set(id, dataUrl, attachStore)
}

async function loadBlob(id: string): Promise<string | undefined> {
  try {
    return await get<string>(id, attachStore)
  } catch {
    return undefined
  }
}

/** 删除所有未被当前会话引用的 blob（孤儿清理） */
async function delUnreferencedBlobs(referenced: Set<string>): Promise<void> {
  try {
    const all = (await keys(attachStore)) as string[]
    const orphans = all.filter((k) => !referenced.has(k))
    if (orphans.length) {
      await Promise.all(orphans.map((k) => del(k, attachStore)))
    }
  } catch {
    /* 清理失败不影响主流程 */
  }
}

export async function clearBlobs(): Promise<void> {
  try {
    await clear(attachStore)
  } catch {
    /* ignore */
  }
  savedBlobIds.clear()
}

/** 把图片 dataUrl 外置到 blob store，主 JSON 只留标记 */
async function externalize(serialized: string | null | undefined): Promise<string | null | undefined> {
  if (!serialized) return serialized
  let parsed: AnyRec
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return serialized
  }
  const conversations = parsed?.state?.conversations
  if (!Array.isArray(conversations)) return serialized

  const referenced = new Set<string>()
  for (const c of conversations) {
    const messages = c?.messages
    if (!Array.isArray(messages)) continue
    for (const m of messages) {
      const atts = m?.attachments
      if (!Array.isArray(atts)) continue
      for (const a of atts) {
        if (a?.type !== 'image') continue
        referenced.add(a.id)
        if (a.dataUrl) {
          if (!savedBlobIds.has(a.id)) {
            try {
              await saveBlob(a.id, a.dataUrl)
            } catch {
              // 写入失败则保留 dataUrl 兜底，绝不静默丢失图片
              continue
            }
            savedBlobIds.add(a.id)
          }
          delete a.dataUrl
          a.externalized = true
        }
      }
    }
  }

  await delUnreferencedBlobs(referenced)
  return JSON.stringify(parsed)
}

/** 读取时把外置的图片 dataUrl 重新内联，保证渲染与发送模型都能拿到完整图片 */
async function inline(serialized: string | null): Promise<string | null> {
  if (!serialized) return null
  let parsed: AnyRec
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return serialized
  }
  const conversations = parsed?.state?.conversations
  if (!Array.isArray(conversations)) return serialized

  for (const c of conversations) {
    const messages = c?.messages
    if (!Array.isArray(messages)) continue
    for (const m of messages) {
      const atts = m?.attachments
      if (!Array.isArray(atts)) continue
      for (const a of atts) {
        if (a?.externalized) {
          try {
            const d = await loadBlob(a.id)
            if (d) {
              a.dataUrl = d
              savedBlobIds.add(a.id)
            }
          } catch {
            /* ignore */
          }
          delete a.externalized
        }
      }
    }
  }
  return JSON.stringify(parsed)
}

let pauseCount = 0
let pending: { name: string; value: string } | null = null
let safetyTimer: ReturnType<typeof setTimeout> | null = null

/** 真正执行写入（绕过暂停标志）。失败时回退 localStorage 并显式告警。 */
function writeNow(name: string, value: string): Promise<void> {
  return (async () => {
    // 落盘前把图片 blob 外置，主记录只留轻量元数据
    const externalized = await externalize(value)
    const toWrite = externalized ?? value
    try {
      await set(name, toWrite)
    } catch (err) {
      console.warn('[FlyChat] IndexedDB 写入失败，尝试回退 localStorage：', err)
      try {
        localStorage.setItem(name, toWrite)
      } catch (e2) {
        // 两者都失败（通常是配额超限）：明确告警，让上层与用户可知数据可能未保存
        console.error('[FlyChat] 本地存储写入失败，数据可能未保存：', e2)
      }
    }
  })()
}

/** 开始一段高频写入（如流式生成）：暂停持久化，累积最新状态。可嵌套计数。 */
export function pausePersist(): void {
  pauseCount += 1
}

/** 结束一段高频写入：计数归零时把挂起状态落盘。 */
export function resumePersist(): void {
  pauseCount = Math.max(0, pauseCount - 1)
  if (pauseCount === 0) flushPersist()
}

/** 强制把挂起状态写入（忽略暂停计数）。用于流结束、页面卸载/隐藏兜底，避免数据丢失。 */
export function flushPersist(): void {
  if (pauseCount > 0) pauseCount = 0
  if (safetyTimer) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
  if (!pending) return
  const { name, value } = pending
  pending = null
  void writeNow(name, value)
}

export const idbStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const value = await get<string>(name)
      if (value != null) return await inline(value)
    } catch (err) {
      // IndexedDB 不可用时回退到 localStorage，并显式告警而非静默降级
      console.warn('[FlyChat] IndexedDB 读取失败，回退 localStorage：', err)
      try {
        const legacy = localStorage.getItem(name)
        if (legacy != null) return await inline(legacy)
      } catch {
        return null
      }
    }
    // 迁移旧数据
    const legacy = localStorage.getItem(name)
    if (legacy != null) {
      try {
        await set(name, legacy)
        localStorage.removeItem(name)
      } catch (err) {
        console.warn('[FlyChat] 旧数据迁移失败：', err)
      }
      return await inline(legacy)
    }
    return null
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (pauseCount > 0) {
      // 暂停期间只保留最后一次完整状态，避免每次 delta 都序列化整份 store。
      // 另设安全定时器，防止异常路径下数据迟迟不落盘。
      pending = { name, value }
      if (!safetyTimer) safetyTimer = setTimeout(() => flushPersist(), 2000)
      return
    }
    await writeNow(name, value)
  },
  removeItem: async (name: string): Promise<void> => {
    try {
      await del(name)
    } catch {
      /* ignore */
    }
    try {
      await clearBlobs()
    } catch {
      /* ignore */
    }
    localStorage.removeItem(name)
  },
}
