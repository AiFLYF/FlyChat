import { create } from 'zustand'
import {
  deletePreset as apiDeletePreset,
  duplicatePreset as apiDuplicatePreset,
  fetchPresets as apiFetchPresets,
  savePreset as apiSavePreset,
  updatePreset as apiUpdatePreset,
} from '../api/client'
import type { Preset, Settings } from '../types'
import { useChatStore } from './chat'

interface PresetState {
  presets: Preset[]
  activePresetId: string | null
  loading: boolean
  modalOpen: boolean
  editingPreset: Preset | null
  setModalOpen: (open: boolean, preset?: Preset | null) => void
  fetchPresets: () => Promise<void>
  setActivePresetId: (id: string | null) => void
  savePreset: (preset: Partial<Preset>) => Promise<Preset>
  deletePreset: (id: string) => Promise<void>
  duplicatePreset: (id: string, name?: string) => Promise<Preset>
  reset: () => void
}

let sessionVersion = 0
let listRequest = 0

/**
 * 列表请求可能晚于本次变更返回：作废在途请求，避免旧列表把刚写入的结果覆盖掉。
 * 同时收起 loading，否则被作废的请求不会再负责把它关掉。
 */
function invalidateListRequest() {
  listRequest += 1
  if (usePresetStore.getState().loading) usePresetStore.setState({ loading: false })
}

export const usePresetStore = create<PresetState>((set, get) => ({
  presets: [],
  activePresetId: null,
  loading: false,
  modalOpen: false,
  editingPreset: null,

  setModalOpen: (open, preset = null) => set({ modalOpen: open, editingPreset: preset }),

  /**
   * 激活预设时把它的模型 / 提示词 / 采样参数写进当前设置。
   *
   * 之前只记了一个 activePresetId，但发送时前端总会带上 settings.model，
   * 服务端看到「显式指定了模型」就不会用预设的模型——预设绑定的模型等于失效。
   * 这里按「预设是默认值」的语义落一次：用户之后仍可以在模型选择器里改，
   * 改完就是显式覆盖，行为符合预期。
   */
  setActivePresetId: (id) => {
    set({ activePresetId: id })
    const preset = id ? get().presets.find((p) => p.id === id) : null
    if (!preset) return
    const patch: Partial<Settings> = {}
    if (preset.provider) patch.provider = preset.provider
    if (preset.model) patch.model = preset.model
    if (preset.systemPrompt) patch.systemPrompt = preset.systemPrompt
    const p = preset.params
    if (p) {
      if (typeof p.temperature === 'number') patch.temperature = p.temperature
      if (typeof p.topP === 'number') patch.topP = p.topP
      if (typeof p.maxTokens === 'number') patch.maxTokens = p.maxTokens
      if (typeof p.webSearch === 'boolean') patch.webSearch = p.webSearch
      if (typeof p.think === 'boolean') patch.thinking = p.think
    }
    if (Object.keys(patch).length > 0) useChatStore.getState().updateSettings(patch)
  },

  fetchPresets: async () => {
    const request = ++listRequest
    try {
      set({ loading: true })
      const res = await apiFetchPresets()
      if (request === listRequest) set({ presets: res.items || [], loading: false })
    } catch {
      if (request === listRequest) set({ loading: false })
    }
  },

  savePreset: async (preset) => {
    const session = sessionVersion
    let saved: Preset
    if (preset.id) {
      saved = await apiUpdatePreset(preset.id, preset)
      invalidateListRequest()
      if (session !== sessionVersion) return saved
      set((s) => ({
        presets: s.presets.map((p) => (p.id === saved.id ? saved : p)),
        modalOpen: false,
        editingPreset: null,
      }))
    } else {
      saved = await apiSavePreset(preset)
      invalidateListRequest()
      if (session !== sessionVersion) return saved
      set((s) => ({
        presets: [saved, ...s.presets],
        modalOpen: false,
        editingPreset: null,
      }))
    }
    return saved
  },

  deletePreset: async (id) => {
    const session = sessionVersion
    const result = await apiDeletePreset(id)
    // 服务端返回 ok:false 表示不存在或没有权限，不能假装删掉并从列表里移除
    if (!result.ok) throw new Error('预设不存在或没有权限删除')
    invalidateListRequest()
    if (session !== sessionVersion) return
    set((s) => ({
      presets: s.presets.filter((p) => p.id !== id),
      activePresetId: s.activePresetId === id ? null : s.activePresetId,
    }))
  },

  duplicatePreset: async (id, name) => {
    const session = sessionVersion
    const dup = await apiDuplicatePreset(id, name)
    invalidateListRequest()
    if (session === sessionVersion) set((s) => ({ presets: [dup, ...s.presets] }))
    return dup
  },

  reset: () => {
    sessionVersion += 1
    listRequest += 1
    set(usePresetStore.getInitialState())
  },
}))
