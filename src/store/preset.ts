import { create } from 'zustand'
import {
  deletePreset as apiDeletePreset,
  duplicatePreset as apiDuplicatePreset,
  fetchPresets as apiFetchPresets,
  savePreset as apiSavePreset,
  updatePreset as apiUpdatePreset,
} from '../api/client'
import type { Preset } from '../types'

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
}

export const usePresetStore = create<PresetState>((set) => ({
  presets: [],
  activePresetId: null,
  loading: false,
  modalOpen: false,
  editingPreset: null,

  setModalOpen: (open, preset = null) => set({ modalOpen: open, editingPreset: preset }),

  setActivePresetId: (id) => set({ activePresetId: id }),

  fetchPresets: async () => {
    try {
      set({ loading: true })
      const res = await apiFetchPresets()
      set({ presets: res.items || [], loading: false })
    } catch {
      set({ loading: false })
    }
  },

  savePreset: async (preset) => {
    let saved: Preset
    if (preset.id) {
      saved = await apiUpdatePreset(preset.id, preset)
      set((s) => ({
        presets: s.presets.map((p) => (p.id === saved.id ? saved : p)),
        modalOpen: false,
        editingPreset: null,
      }))
    } else {
      saved = await apiSavePreset(preset)
      set((s) => ({
        presets: [saved, ...s.presets],
        modalOpen: false,
        editingPreset: null,
      }))
    }
    return saved
  },

  deletePreset: async (id) => {
    await apiDeletePreset(id)
    set((s) => ({
      presets: s.presets.filter((p) => p.id !== id),
      activePresetId: s.activePresetId === id ? null : s.activePresetId,
    }))
  },

  duplicatePreset: async (id, name) => {
    const dup = await apiDuplicatePreset(id, name)
    set((s) => ({ presets: [dup, ...s.presets] }))
    return dup
  },
}))
