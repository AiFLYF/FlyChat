import { create } from 'zustand'

/** 设置弹窗开关（独立小 store，方便任意组件触发） */
interface SettingsOpenState {
  open: boolean
  setOpen: (open: boolean) => void
}

export const useSettingsOpen = create<SettingsOpenState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))
