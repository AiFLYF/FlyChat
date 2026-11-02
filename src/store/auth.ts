import { create } from 'zustand'
import { fetchAuthConfig, fetchAuthMe, loginUser, logoutUser, setupAdmin } from '../api/client'
import { activateChatStorage } from './chat'
import { useComposer } from './composer'
import { useKnowledgeStore } from './knowledge'
import { useArtifactStore } from './artifact'
import { usePresetStore } from './preset'
import type { AuthConfig, AuthUser } from '../types'

interface AuthState {
  config: AuthConfig | null
  user: AuthUser | null
  loading: boolean
  error: string | null
  modalOpen: boolean
  userManagementOpen: boolean
  setModalOpen: (open: boolean) => void
  setUserManagementOpen: (open: boolean) => void
  checkAuth: () => Promise<void>
  login: (username: string, password: string) => Promise<void>
  setup: (username: string, password: string, displayName?: string) => Promise<void>
  logout: () => Promise<void>
  setUser: (user: AuthUser | null) => Promise<void>
}

let authCheck: Promise<void> | null = null
let activeIdentity: string | null = null
let authQueue: Promise<void> = Promise.resolve()
let blockingOperations = 0

function runAuth(operation: () => Promise<void>, blocking = true): Promise<void> {
  if (blocking) {
    blockingOperations += 1
    useAuthStore.setState({ loading: true })
  }
  const result = authQueue.then(operation)
  authQueue = result.catch(() => {})
  return result.finally(() => {
    if (blocking) blockingOperations -= 1
    useAuthStore.setState({ loading: blockingOperations > 0 })
  })
}

async function activateIdentity(config: AuthConfig | null, user: AuthUser | null) {
  const name = config?.authMode === 'multi'
    ? user ? `flychat-user-${user.id}` : 'flychat-guest'
    : 'flychat-store'
  if (activeIdentity === name) return
  useAuthStore.setState({ loading: true })
  useComposer.setState(useComposer.getInitialState())
  useKnowledgeStore.getState().reset()
  useArtifactStore.setState(useArtifactStore.getInitialState())
  usePresetStore.getState().reset()
  await activateChatStorage(name)
  activeIdentity = name
}

export const useAuthStore = create<AuthState>((set, get) => ({
  config: null,
  user: null,
  loading: true,
  error: null,
  modalOpen: false,
  userManagementOpen: false,

  setModalOpen: (open) => set({ modalOpen: open }),
  setUserManagementOpen: (open) => set({ userManagementOpen: open }),

  checkAuth: () => {
    if (authCheck) return authCheck
    authCheck = runAuth(async () => {
      set({ error: null })
      try {
        const config = await fetchAuthConfig()
        const me = await fetchAuthMe()
        await activateIdentity(config, me.user)
        set({
          config,
          user: me.user,
          modalOpen: config.authMode === 'multi' && (!me.user || config.needsSetup),
        })
      } catch (err) {
        if (get().config) throw err
        set({ error: err instanceof Error ? err.message : '无法检查登录状态，请重试' })
      }
    }, !get().config).finally(() => { authCheck = null })
    return authCheck
  },

  login: (username, password) => runAuth(async () => {
    const res = await loginUser({ username, password })
    if (res.ok && res.user) {
      await activateIdentity(get().config, res.user)
      set({ user: res.user, modalOpen: false, error: null })
    }
  }),

  setup: (username, password, displayName) => runAuth(async () => {
    const res = await setupAdmin({ username, password, displayName })
    if (res.ok && res.user) {
      const config = await fetchAuthConfig()
      await activateIdentity(config, res.user)
      set({ user: res.user, config, modalOpen: false, error: null })
    }
  }),

  logout: () => runAuth(async () => {
    await logoutUser()
    await activateIdentity(get().config, null)
    set({ user: null, modalOpen: get().config?.authMode === 'multi', userManagementOpen: false })
  }),

  setUser: (user) => {
    if (!user) set({ user: null, modalOpen: get().config?.authMode === 'multi' })
    return runAuth(async () => {
      await activateIdentity(get().config, user)
      set({ user, modalOpen: !user && get().config?.authMode === 'multi' })
    })
  },
}))

if (typeof window !== 'undefined') {
  window.addEventListener('flychat:login_required', () => {
    const state = useAuthStore.getState()
    if (state.config?.authMode === 'multi' && state.user) void state.setUser(null)
  })
}
