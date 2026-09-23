// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Work-instruction content shapes — the JSONB the schema stores for step
 * content and for a traveler line's frozen template snapshot. The schema
 * modules re-export these; they live here so the authoring and execution UI
 * can name them without importing the schema.
 */

/** Frozen copy of a WorkInstruction template taken at instantiation. */
export interface InstructionSnapshot {
  name: string
  description: string | null
  estimatedTime: number | null // minutes
  difficulty: string | null
  safetyNotes: string | null
  requiredTools: string | null
  operations: Array<{
    id: string
    orderIndex: number
    title: string
    description: string | null
    estimatedTime: number | null
  }>
  steps: Array<{
    id: string
    operationId: string | null
    orderIndex: number
    title: string | null
    content: StepContent
  }>
}

/**
 * Step content block types for the simplified block editor
 */
export type StepBlockType = 'text' | 'image' | 'parametric' | 'dataField'

/**
 * Step content block structure for JSONB storage
 */
export interface StepContentBlock {
  id: string
  type: StepBlockType
  // For text blocks
  content?: string // Rich text HTML content
  // For image blocks
  fileId?: string // Reference to file in vault
  alt?: string
  caption?: string
  // For parametric blocks
  partId?: string // Reference to part
  attributePath?: string // e.g., 'weight', 'material', 'attributes.tensileStrength'
  label?: string // Display label
  unit?: string // Display unit override
  fallbackValue?: string // Shown when part unavailable
  // For dataField blocks
  fieldType?: 'text' | 'numeric' | 'checkbox' | 'passFail'
  fieldLabel?: string
  fieldRequired?: boolean
  fieldValidation?: {
    min?: number
    max?: number
    pattern?: string
  }
}

/**
 * Step content schema stored in JSONB
 */
export interface StepContent {
  blocks: Array<StepContentBlock>
}
