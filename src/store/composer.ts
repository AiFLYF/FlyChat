import { create } from 'zustand'

/**
 * 输入框草稿状态（独立于持久化 store，刷新即清空）
 * 抽出来是为了让空态示例提示词能直接填充输入框
 */
interface ComposerState {
  text: string
  /** 每次外部填充时递增，用于触发输入框聚焦 */
  focusToken: number
  setText: (text: string) => void
  fill: (text: string) => void
  clear: () => void
}

export const useComposer = create<ComposerState>((set) => ({
  text: '',
  focusToken: 0,
  setText: (text) => set({ text }),
  fill: (text) => set((s) => ({ text, focusToken: s.focusToken + 1 })),
  clear: () => set({ text: '' }),
}))
