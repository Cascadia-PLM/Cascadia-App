// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CAD Generation Types
 *
 * Types for the FreeCAD script generation pipeline, assembly composition,
 * and the overall CAD autogeneration workflow.
 */

import type { ManufacturingConstraints } from '@/design-engine/types'

/** How a part's geometry was produced. */
export type CadGenerationMethod = 'parametric' | 'freecad' | 'mechanism'

export interface CadGenerationResult {
  tempId: string
  itemId: string
  success: boolean
  generationMethod?: CadGenerationMethod
  vaultFileId?: string
  errorMessage?: string
  boundingBox?: BoundingBox3D
  /** The FreeCAD Python script that produced the geometry (`freecad` method). */
  script?: string
  /** Script attempts the AI agent needed (`freecad` method). */
  iterations?: number
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

/**
 * The planner's output. `placements` is the engine-agnostic source of truth:
 * the render worker consumes it directly, and `generateAssemblyScript`
 * serializes it to a FreeCAD Python script kept on the node as a portable,
 * human-readable record of the composition.
 */
export interface AssemblyPlan {
  assemblyTempId: string
  reasoning: string
  placements: Array<AssemblyChildPlacement>
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
