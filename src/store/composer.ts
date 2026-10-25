import { create } from 'zustand'
import type { Attachment } from '../types'

/**
 * 输入框状态（独立于持久化 store，刷新即清空）
 * - text / attachments 为当前会话的草稿
 * - drafts 按会话 id 保存草稿，切换会话时自动保存与恢复
 */
interface ComposerState {
  text: string
  attachments: Attachment[]
  /** 每次外部填充时递增，用于触发输入框聚焦 */
  focusToken: number
  /** 当前草稿所属的会话 key */
  activeKey: string
  drafts: Record<string, { text: string; attachments: Attachment[] }>

  setText: (text: string) => void
  setAttachments: (attachments: Attachment[]) => void
  addAttachment: (attachment: Attachment) => void
  removeAttachment: (id: string) => void
  clear: () => void
  fill: (text: string) => void
  /** 只触发聚焦（不改内容），供全局快捷键使用 */
  bumpFocus: () => void
  /** 切换会话时保存并恢复草稿 */
  switchTo: (key: string) => void
}

export const useComposer = create<ComposerState>((set, get) => ({
  text: '',
  attachments: [],
  focusToken: 0,
  activeKey: 'new',
  drafts: {},

  setText: (text) => set({ text }),
  setAttachments: (attachments) => set({ attachments }),
  addAttachment: (attachment) => set((s) => ({ attachments: [...s.attachments, attachment] })),
  removeAttachment: (id) => set((s) => ({ attachments: s.attachments.filter((a) => a.id !== id) })),
  clear: () => set({ text: '', attachments: [] }),
  fill: (text) => set((s) => ({ text, focusToken: s.focusToken + 1 })),
  bumpFocus: () => set((s) => ({ focusToken: s.focusToken + 1 })),

  switchTo: (key) => {
    const { activeKey, text, attachments, drafts } = get()
    if (key === activeKey) return
    const nextDrafts = {
      ...drafts,
      [activeKey]: { text, attachments },
    }
    const next = nextDrafts[key]
    set({
      activeKey: key,
      drafts: nextDrafts,
      text: next?.text ?? '',
      attachments: next?.attachments ?? [],
    })
  },
}))
