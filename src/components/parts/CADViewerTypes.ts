/** Background preset names */
export type BackgroundPreset = 'light' | 'dark' | 'neutral' | 'studio'

/** Material preset names */
export type MaterialPreset =
  | 'default'
  | 'blue_metal'
  | 'white_plastic'
  | 'dark_metal'
  | 'gold'

/** Standard camera views */
export type StandardView =
  | 'front'
  | 'back'
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'iso'

/** Background preset configuration */
export interface BackgroundConfig {
  label: string
  topColor: string
  bottomColor: string
  environmentPreset: string
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
    environmentPreset: 'city',
    contactShadows: false,
  },
  dark: {
    label: 'Dark',
    topColor: '#1e293b',
    bottomColor: '#0f172a',
    environmentPreset: 'night',
    contactShadows: false,
  },
  neutral: {
    label: 'Neutral',
    topColor: '#d1d5db',
    bottomColor: '#9ca3af',
    environmentPreset: 'warehouse',
    contactShadows: false,
  },
  studio: {
    label: 'Studio',
    topColor: '#e5e7eb',
    bottomColor: '#f3f4f6',
    environmentPreset: 'studio',
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
