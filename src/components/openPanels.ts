import { create } from 'zustand'

/** 弹窗开关：setOpen 支持直接传值或传函数（便于 toggle） */
interface OpenState {
  open: boolean
  setOpen: (open: boolean | ((v: boolean) => boolean)) => void
}

/** 设置弹窗开关（独立小 store，方便任意组件触发） */
export const useSettingsOpen = create<OpenState>((set) => ({
  open: false,
  setOpen: (v) => set((s) => ({ open: typeof v === 'function' ? v(s.open) : v })),
}))

/** 快捷键说明面板开关 */
export const useShortcutsOpen = create<OpenState>((set) => ({
  open: false,
  setOpen: (v) => set((s) => ({ open: typeof v === 'function' ? v(s.open) : v })),
}))

/** 用量分析弹窗开关 */
export const useUsageOpen = create<OpenState>((set) => ({
  open: false,
  setOpen: (v) => set((s) => ({ open: typeof v === 'function' ? v(s.open) : v })),
}))

/** 命令面板开关 */
export const useCommandPaletteOpen = create<OpenState>((set) => ({
  open: false,
  setOpen: (v) => set((s) => ({ open: typeof v === 'function' ? v(s.open) : v })),
}))

/** 智能体市场弹窗开关 */
export const useMarketOpen = create<OpenState>((set) => ({
  open: false,
  setOpen: (v) => set((s) => ({ open: typeof v === 'function' ? v(s.open) : v })),
}))

