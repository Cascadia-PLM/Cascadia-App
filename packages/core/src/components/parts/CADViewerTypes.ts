// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/** Background preset names */
export type BackgroundPreset = 'light' | 'dark' | 'neutral' | 'studio'

/** Material preset names */
export type MaterialPreset =
  'default' | 'blue_metal' | 'white_plastic' | 'dark_metal' | 'gold'

/** Standard camera views */
export type StandardView =
  'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso'

/**
 * Image-based lighting for a background preset.
 *
 * Described rather than fetched. drei's `<Environment preset="…">` pulls a
 * 1-2 MB HDR from a public CDN (raw.githack.com) on first use, which is both
 * wrong for an air-gapped install and was a hard crash: R3F loads it through
 * suspend-react's module-global cache, which memoizes a rejection forever, so
 * one failed fetch made every later mount of the viewer re-throw during render
 * until a full page reload. These values drive a few emissive panels instead —
 * see `SceneEnvironment` in CADViewer.tsx.
 */
export interface EnvironmentConfig {
  /** Overall brightness of the rig. */
  intensity: number
  /** Broad overhead source — the dominant reflection on an up-facing surface. */
  skyColor: string
  /** Bounce from below, so undersides read as shaded rather than dead black. */
  groundColor: string
  /** Side panels, which put the highlight along vertical edges. */
  rimColor: string
}

/** Background preset configuration */
export interface BackgroundConfig {
  label: string
  topColor: string
  bottomColor: string
  environment: EnvironmentConfig
  contactShadows: boolean
}

/** Material preset configuration */
export interface MaterialConfig {
  label: string
  color: string
  metalness: number
  roughness: number
}

/** Full viewer state */
export interface CADViewerState {
  wireframe: boolean
  showGrid: boolean
  isFullscreen: boolean
  backgroundPreset: BackgroundPreset
  materialPreset: MaterialPreset
}

export const BACKGROUND_PRESETS: Record<BackgroundPreset, BackgroundConfig> = {
  light: {
    label: 'Light',
    topColor: '#f8fafc',
    bottomColor: '#e2e8f0',
    environment: {
      intensity: 0.9,
      skyColor: '#ffffff',
      groundColor: '#cbd5e1',
      rimColor: '#e0f2fe',
    },
    contactShadows: false,
  },
  dark: {
    label: 'Dark',
    topColor: '#1e293b',
    bottomColor: '#0f172a',
    environment: {
      intensity: 0.35,
      skyColor: '#94a3b8',
      groundColor: '#0f172a',
      rimColor: '#38bdf8',
    },
    contactShadows: false,
  },
  neutral: {
    label: 'Neutral',
    topColor: '#d1d5db',
    bottomColor: '#9ca3af',
    environment: {
      intensity: 0.7,
      skyColor: '#e5e7eb',
      groundColor: '#78716c',
      rimColor: '#fed7aa',
    },
    contactShadows: false,
  },
  studio: {
    label: 'Studio',
    topColor: '#e5e7eb',
    bottomColor: '#f3f4f6',
    environment: {
      intensity: 1.1,
      skyColor: '#ffffff',
      groundColor: '#e5e7eb',
      rimColor: '#ffffff',
    },
    contactShadows: true,
  },
}

export const MATERIAL_PRESETS: Record<MaterialPreset, MaterialConfig> = {
  default: {
    label: 'Gray Metal',
    color: '#6b7280',
    metalness: 0.6,
    roughness: 0.4,
  },
  blue_metal: {
    label: 'Blue Metal',
    color: '#3b82f6',
    metalness: 0.7,
    roughness: 0.3,
  },
  white_plastic: {
    label: 'White Plastic',
    color: '#f1f5f9',
    metalness: 0.0,
    roughness: 0.6,
  },
  dark_metal: {
    label: 'Dark Metal',
    color: '#374151',
    metalness: 0.8,
    roughness: 0.2,
  },
  gold: {
    label: 'Gold',
    color: '#d97706',
    metalness: 0.9,
    roughness: 0.15,
  },
}
