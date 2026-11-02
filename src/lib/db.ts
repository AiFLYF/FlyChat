import { get, set, del, keys, clear, createStore } from 'idb-keyval'

type AnyRec = Record<string, any>
const attachmentStores = new Map<string, { store: ReturnType<typeof createStore>; saved: Set<string> }>()

function attachmentsFor(name: string) {
  let entry = attachmentStores.get(name)
  if (!entry) {
    const dbName = name === 'flychat-store' ? 'flychat-attachments' : `${name}-attachments`
    entry = { store: createStore(dbName, 'blobs'), saved: new Set<string>() }
    attachmentStores.set(name, entry)
  }
  return entry
}

async function delUnreferencedBlobs(name: string, referenced: Set<string>): Promise<void> {
  const { store, saved } = attachmentsFor(name)
  try {
    const all = await keys(store)
    for (const key of all) {
      if (typeof key !== 'string' || referenced.has(key)) continue
      await del(key, store)
      saved.delete(key)
    }
  } catch {
    // 清理失败不应阻止保存当前会话。
  }
}

export async function clearBlobs(name = 'flychat-store'): Promise<void> {
  const { store, saved } = attachmentsFor(name)
  await clear(store)
  saved.clear()
}

async function externalize(name: string, serialized: string): Promise<{ value: string; referenced?: Set<string> }> {
  let parsed: AnyRec
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return { value: serialized }
  }
  const conversations = parsed?.state?.conversations
  if (!Array.isArray(conversations)) return { value: serialized }
  const { store, saved } = attachmentsFor(name)
  const referenced = new Set<string>()
  for (const c of conversations) {
    for (const m of c?.messages || []) {
      for (const a of m?.attachments || []) {
        if (a?.type !== 'image') continue
        referenced.add(a.id)
        if (!a.dataUrl) continue
        if (!saved.has(a.id)) {
          try {
            await set(a.id, a.dataUrl, store)
          } catch {
            continue
          }
          saved.add(a.id)
        }
        delete a.dataUrl
        a.externalized = true
      }
    }
  }
  return { value: JSON.stringify(parsed), referenced }
}

async function inline(name: string, serialized: string | null): Promise<string | null> {
  if (!serialized) return null
  let parsed: AnyRec
  try {
    parsed = JSON.parse(serialized)
  } catch {
    return serialized
  }
  const conversations = parsed?.state?.conversations
  if (!Array.isArray(conversations)) return serialized
  const { store, saved } = attachmentsFor(name)
  for (const c of conversations) {
    for (const m of c?.messages || []) {
      for (const a of m?.attachments || []) {
        if (!a?.externalized) continue
        try {
          const dataUrl = await get<string>(a.id, store)
          if (dataUrl) {
            a.dataUrl = dataUrl
            saved.add(a.id)
          }
        } catch {
          // 主记录仍可恢复，保留其余附件元数据。
        }
        delete a.externalized
      }
    }
  }
  return JSON.stringify(parsed)
}

let pauseCount = 0
let persistenceEnabled = true
const pending = new Map<string, string>()
let safetyTimer: ReturnType<typeof setTimeout> | null = null
let writeQueue: Promise<void> = Promise.resolve()

export function setPersistenceEnabled(enabled: boolean): void {
  persistenceEnabled = enabled
}

// 串行保存保证旧快照不会覆盖新快照，也不会删除尚在写入的图片。
function writeNow(name: string, value: string): Promise<void> {
  writeQueue = writeQueue.then(async () => {
    const { value: toWrite, referenced } = await externalize(name, value)
    try {
      await set(name, toWrite)
      localStorage.removeItem(name)
    } catch (err) {
      console.warn('[FlyChat] IndexedDB 写入失败，尝试回退 localStorage：', err)
      localStorage.setItem(name, JSON.stringify({ flychatStorageFallback: 1, value }))
    }
    if (referenced) await delUnreferencedBlobs(name, referenced)
  }).catch((err) => {
    console.error('[FlyChat] 本地存储写入失败，数据可能未保存：', err)
  })
  return writeQueue
}

export function pausePersist(): void {
  pauseCount += 1
}

export function resumePersist(): void {
  pauseCount = Math.max(0, pauseCount - 1)
  if (pauseCount === 0) void flushPersist()
}

export function flushPersist(): Promise<void> {
  if (safetyTimer) {
    clearTimeout(safetyTimer)
    safetyTimer = null
  }
  for (const [name, value] of pending) void writeNow(name, value)
  pending.clear()
  return writeQueue
}

export const idbStorage = {
  getItem: async (name: string): Promise<string | null> => {
    if (name === 'flychat-guest') return null
    await writeQueue
    let legacy: string | null = null
    try {
      legacy = localStorage.getItem(name)
      const fallback = legacy ? JSON.parse(legacy) : null
      // 旧版未标记副本可能比 IDB 更旧，不能将其自动覆盖到现有记录。
      if (fallback?.flychatStorageFallback === 1 && typeof fallback.value === 'string') {
        try {
          await set(name, fallback.value)
          localStorage.removeItem(name)
        } catch (err) {
          console.warn('[FlyChat] 本地数据迁移失败：', err)
        }
        return await inline(name, fallback.value)
      }
    } catch (err) {
      console.warn('[FlyChat] localStorage 读取失败：', err)
    }
    try {
      const value = await get<string>(name)
      if (value != null) return await inline(name, value)
    } catch (err) {
      console.warn('[FlyChat] IndexedDB 读取失败：', err)
    }
    if (legacy != null) {
      try {
        await set(name, legacy)
        localStorage.removeItem(name)
      } catch (err) {
        console.warn('[FlyChat] 旧数据迁移失败：', err)
      }
      return await inline(name, legacy)
    }
    return null
  },
  setItem: async (name: string, value: string): Promise<void> => {
    if (!persistenceEnabled || name === 'flychat-guest') return
    if (pauseCount > 0) {
      pending.set(name, value)
      if (!safetyTimer) safetyTimer = setTimeout(() => void flushPersist(), 2000)
      return
    }
    await writeNow(name, value)
  },
  removeItem: async (name: string): Promise<void> => {
    pending.delete(name)
    await writeQueue
    await del(name)
    await clearBlobs(name)
    localStorage.removeItem(name)
  },
}
