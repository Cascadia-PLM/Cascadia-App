/**
 * CAD Generation Types
 *
 * Types for the Zoo Text-to-CAD pipeline, assembly composition,
 * and the overall CAD autogeneration workflow.
 */

import type { ManufacturingConstraints } from '@/lib/design-engine/types'

export interface CadGenerationRequest {
  prompt: string
  outputFormat: 'step' | 'stl'
  tempId: string
  itemId: string
  partName: string
}

export interface CadGenerationResult {
  tempId: string
  itemId: string
  success: boolean
  generationMethod?: 'parametric' | 'zoo' | 'mechanism'
  stepFileContent?: Buffer
  vaultFileId?: string
  errorMessage?: string
  zooRequestId?: string
  boundingBox?: BoundingBox3D
}

export interface BoundingBox3D {
  minX: number
  minY: number
  minZ: number
  maxX: number
  maxY: number
  maxZ: number
}

export interface Transform3D {
  translation: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number } // Euler angles in degrees
}

export interface AssemblyChildPlacement {
  tempId: string
  partName: string
  stepFileKey: string
  transform: Transform3D
  quantity: number
}

export interface AssemblyPlan {
  assemblyTempId: string
  reasoning: string
  placements: Array<AssemblyChildPlacement>
  kclCode: string
}

export interface AssemblyValidation {
  valid: boolean
  issues: Array<{
    severity: 'error' | 'warning'
    message: string
    partTempId?: string
  }>
}

export interface CadPromptContext {
  partName: string
  partDescription: string
  material?: string
  interfaces: Array<{
    description: string
    mateType: string
    geometry: {
      shape: string
      nominalDimensions: Record<string, number>
      units: string
      count?: number
      patternType?: string
      patternSpacing?: number
    }
    locationHint: string
  }>
  parentAssemblyName?: string
  parentAssemblyDescription?: string
  siblingParts?: Array<{
    name: string
    description: string
    boundingBox?: BoundingBox3D
  }>
  overallProductDescription?: string
  additionalFeedback?: string
  manufacturingConstraints?: ManufacturingConstraints
  cadGenerationHint?: string
}

/**
 * Zoo Text-to-CAD API response structures
 */
export interface ZooTextToCadResponse {
  id: string
  status: 'queued' | 'in_progress' | 'completed' | 'failed'
  created_at: string
  completed_at?: string
  error?: string
  /** Map of output filename to base64-encoded file content */
  outputs?: Record<string, string>
}
