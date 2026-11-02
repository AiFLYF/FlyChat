import { createFolder as createFolderApi, fetchFolders, updateConversationMetadata } from '../api/client'
import { useChatStore } from '../store/chat'
import type { ConversationFolder } from '../types'

/**
 * 把服务端文件夹与本地合并（挂载时调用）。
 *
 * 本地有、服务端没有的 = 还没迁移上去的（首次升级，或上次迁移中途失败）。
 * 之前只要服务端非空就直接用服务端列表，把本地这批整个丢掉：
 * 一次迁移里如果第 2 个 createFolderApi 失败，第 1 个已经落到服务端，
 * 下次挂载就走「服务端非空」分支，失败的那个文件夹永远没机会再迁移。
 * 现在统一成「按 id 差集补齐 + 合并」，两条路径都走同一套逻辑。
 *
 * 同名即视为「上次其实已经建成功，只是没拿到响应」：直接复用服务端那条，
 * 否则每次挂载都会多建一个同名文件夹。单个推失败就留在本地，下次再试。
 *
 * 放在同步层而不是组件里：组件只负责 dispatch，异步迁移跨越卸载时用 isCancelled 停手。
 */
export async function syncFoldersFromServer({
  isCancelled,
}: { isCancelled?: () => boolean } = {}): Promise<void> {
  const res = await fetchFolders()
  if (isCancelled?.() || !res || !Array.isArray(res.items)) return

  const serverFolders: ConversationFolder[] = res.items.map((it) => ({
    id: it.id,
    name: it.name,
    emoji: it.icon || '📁',
    createdAt: Date.now(),
  }))
  const serverIds = new Set(serverFolders.map((f) => f.id))

  const store = useChatStore.getState()
  const pending = store.folders.filter((f) => !serverIds.has(f.id))
  if (pending.length === 0) {
    store.setFolders(serverFolders)
    return
  }

  const idMap = new Map<string, string>()
  const createdFolders: ConversationFolder[] = []
  const byName = new Map(serverFolders.map((f) => [f.name.trim(), f]))
  for (const f of pending) {
    if (isCancelled?.()) return
    const same = byName.get(f.name.trim())
    if (same) {
      idMap.set(f.id, same.id)
      continue
    }
    try {
      const created = await createFolderApi({ name: f.name, icon: f.emoji })
      if (created?.id) {
        idMap.set(f.id, created.id)
        createdFolders.push({ ...f, id: created.id })
      }
    } catch {
      // 单个推失败就留在本地，下次挂载再试；不能因为失败把本地删掉
    }
  }
  if (isCancelled?.()) return

  // 服务端已有的 + 本次新建的 + 仍然推不上去的本地项，一个都不能少
  const merged: ConversationFolder[] = [
    ...serverFolders,
    ...createdFolders,
    ...pending.filter((f) => !idMap.has(f.id)),
  ]
  useChatStore.getState().setFolders(merged)
  if (idMap.size === 0) return

  useChatStore.getState().applyFolderIdMap(idMap)

  // 会话归属也要落库，否则服务端只知道文件夹存在、不知道哪些会话在里面
  for (const c of useChatStore.getState().conversations) {
    if (c.folderId) void updateConversationMetadata(c.id, { folderId: c.folderId }).catch(() => {})
  }
}
