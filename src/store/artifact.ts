import { create } from 'zustand'
import type { ArtifactItem } from '../types'

export type ArtifactViewport = 'desktop' | 'tablet' | 'mobile'

interface ArtifactStore {
  activeArtifact: ArtifactItem | null
  artifacts: ArtifactItem[]
  open: boolean
  viewMode: 'preview' | 'code'
  viewport: ArtifactViewport
  isFullscreen: boolean

  openArtifact: (artifact: ArtifactItem) => void
  closeArtifact: () => void
  setViewMode: (mode: 'preview' | 'code') => void
  setViewport: (viewport: ArtifactViewport) => void
  toggleFullscreen: () => void
  addArtifact: (artifact: ArtifactItem) => void
}

export const useArtifactStore = create<ArtifactStore>((set) => ({
  activeArtifact: null,
  artifacts: [],
  open: false,
  viewMode: 'preview',
  viewport: 'desktop',
  isFullscreen: false,

  openArtifact: (artifact) =>
    set((s) => ({
      activeArtifact: artifact,
      artifacts: s.artifacts.some((a) => a.id === artifact.id)
        ? s.artifacts.map((a) => (a.id === artifact.id ? artifact : a))
        : [artifact, ...s.artifacts],
      open: true,
    })),

  closeArtifact: () => set({ open: false, isFullscreen: false }),

  setViewMode: (viewMode) => set({ viewMode }),

  setViewport: (viewport) => set({ viewport }),

  toggleFullscreen: () => set((s) => ({ isFullscreen: !s.isFullscreen })),

  addArtifact: (artifact) =>
    set((s) => ({
      artifacts: s.artifacts.some((a) => a.id === artifact.id)
        ? s.artifacts.map((a) => (a.id === artifact.id ? artifact : a))
        : [artifact, ...s.artifacts],
    })),
}))
