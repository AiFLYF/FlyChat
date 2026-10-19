import { create } from 'zustand'
import {
  fetchAuthConfig,
  fetchAuthMe,
  loginUser,
  logoutUser,
  setupAdmin,
} from '../api/client'
import type { AuthConfig, AuthUser } from '../types'

interface AuthState {
  config: AuthConfig | null
  user: AuthUser | null
  loading: boolean
  modalOpen: boolean
  userManagementOpen: boolean
  setModalOpen: (open: boolean) => void
  setUserManagementOpen: (open: boolean) => void
  checkAuth: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  setup: (username: string, password: string, displayName?: string) => Promise<void>
  logout: () => Promise<void>
  setUser: (user: AuthUser | null) => void
}

export const useAuthStore = create<AuthState>((set, get) => ({
  config: null,
  user: null,
  loading: true,
  modalOpen: false,
  userManagementOpen: false,

  setModalOpen: (open) => set({ modalOpen: open }),
  setUserManagementOpen: (open) => set({ userManagementOpen: open }),

  checkAuth: async () => {
    try {
      set({ loading: true })
      const config = await fetchAuthConfig()
      const me = await fetchAuthMe()
      set({
        config,
        user: me.user,
        loading: false,
        // 如果是多用户模式且未登录，或需要 setup，自动呼起弹窗
        modalOpen: config.authMode === 'multi' && (!me.user || config.needsSetup),
      })
    } catch {
      set({ loading: false })
    }
  },

  login: async (username, password) => {
    const res = await loginUser({ username, password })
    if (res.ok && res.user) {
      set({ user: res.user, modalOpen: false })
    }
  },

  setup: async (username, password, displayName) => {
    const res = await setupAdmin({ username, password, displayName })
    if (res.ok && res.user) {
      const config = await fetchAuthConfig().catch(() => null)
      set({ user: res.user, config: config || get().config, modalOpen: false })
    }
  },

  logout: async () => {
    try {
      await logoutUser()
    } finally {
      set({ user: null, modalOpen: get().config?.authMode === 'multi' })
    }
  },

  setUser: (user) => set({ user }),
}))

// 全局 401 login_required 监听
if (typeof window !== 'undefined') {
  window.addEventListener('flychat:login_required', () => {
    const state = useAuthStore.getState()
    if (state.config?.authMode === 'multi') {
      state.setUser(null)
      state.setModalOpen(true)
    }
  })
}
