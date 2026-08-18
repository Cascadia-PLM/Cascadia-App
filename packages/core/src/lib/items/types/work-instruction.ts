// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'
import type {
  StepBlockType,
  StepContent,
  StepContentBlock,
} from '@/lib/db/schema/items'

// Re-export step types for use in components
export type { StepContent, StepContentBlock, StepBlockType }

// WorkInstruction-specific interface
export interface WorkInstruction extends BaseItem {
  itemType: 'WorkInstruction'
  description?: string
  estimatedTime?: number // in minutes
  difficulty?: 'Easy' | 'Medium' | 'Hard'
  safetyNotes?: string
  requiredTools?: string
  /**
   * The part this procedure builds. Write-only creation input, not a column on
   * `work_instructions`: it is persisted as the attachment row flagged
   * `isOutput`, and it is what `designId` is inherited from. Read it back via
   * `GET /api/v1/work-instructions/:id/parts`.
   */
  outputPartId?: string
}

// Operation interface
export interface WorkInstructionOperation {
  id: string
  workInstructionId: string
  orderIndex: number
  title: string
  description?: string
  estimatedTime?: number // in minutes
  createdAt?: Date | string
  updatedAt?: Date | string
}

// Step interface for API responses
export interface WorkInstructionStep {
  id: string
  workInstructionId: string
  operationId?: string | null
  orderIndex: number
  title?: string
  content: StepContent
  createdAt?: Date | string
  updatedAt?: Date | string
}

// WorkInstruction with steps and operations (for detail view)
export interface WorkInstructionWithSteps extends WorkInstruction {
  steps: Array<WorkInstructionStep>
  operations?: Array<WorkInstructionOperation>
}

// Part attachment interface
export interface WorkInstructionPartAttachment {
  id: string
  workInstructionId: string
  partId: string
  /** The part this procedure builds. At most one per work instruction. */
  isOutput: boolean
  inheritToMBOM: boolean
  inheritedFromId?: string | null
  createdAt?: Date | string
  createdBy: string
  // Populated from join
  part?: {
    id: string
    itemNumber: string
    name?: string
    revision: string
  }
}

// Change alert interface
export interface WorkInstructionChangeAlert {
  id: string
  workInstructionId: string
  partId: string
  ecoId?: string | null
  changeType: 'part_modified' | 'part_obsoleted' | 'parametric_stale'
  changedFields?: Array<string>
  previousValues?: Record<string, unknown>
  newValues?: Record<string, unknown>
  status: 'pending' | 'acknowledged' | 'dismissed'
  acknowledgedBy?: string | null
  acknowledgedAt?: Date | string | null
  notes?: string | null
  createdAt?: Date | string
  // Populated from joins
  part?: {
    id: string
    itemNumber: string
    name?: string
  }
  eco?: {
    id: string
    itemNumber: string
    name?: string
  }
}

/**
 * A work instruction's own fields — everything that is actually a column on
 * `work_instructions`. Edits validate against this, because the output part is
 * an attachment rather than a column and an edit does not restate it.
 */
export const workInstructionEditSchema = baseItemSchema.extend({
  itemType: z.literal('WorkInstruction'),
  description: z.string().max(5000).optional(),
  estimatedTime: z.number().int().positive().optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  safetyNotes: z.string().max(5000).optional(),
  requiredTools: z.string().max(2000).optional(),
})

/**
 * The creation contract, and what `ItemTypeRegistry` registers for this type.
 *
 * A work instruction is a procedure for building one specific part, so it
 * cannot be created without naming that part — exactly how `partSchema`
 * requires `designId`. Registering it here means both server creation paths
 * (`ItemService.create` and `ItemVersioningFacade.createOnBranch`) enforce it,
 * so a programmatic caller cannot mint a design-less work instruction either.
 *
 * Only creation parses this: `ItemService.update` does not validate against the
 * type schema, and `createRevision` copies the stored `work_instructions` row
 * straight across without going near Zod.
 */
export const workInstructionSchema = workInstructionEditSchema.extend({
  outputPartId: z.string().uuid({ message: 'Output part is required' }),
})

// Operation validation schema
export const workInstructionOperationSchema = z.object({
  id: z.string().uuid().optional(),
  workInstructionId: z.string().uuid(),
  orderIndex: z.number().int().min(0),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  estimatedTime: z.number().int().positive().optional(),
})

// Step content block schema
export const stepContentBlockSchema = z.object({
  id: z.string(),
  type: z.enum(['text', 'image', 'parametric', 'dataField']),
  content: z.string().optional(), // For text blocks
  fileId: z.string().uuid().optional(), // For image blocks
  alt: z.string().optional(),
  caption: z.string().optional(),
  // For parametric blocks
  partId: z.string().uuid().optional(),
  attributePath: z.string().optional(),
  label: z.string().optional(),
  unit: z.string().optional(),
  fallbackValue: z.string().optional(),
  // For dataField blocks
  fieldType: z.enum(['text', 'numeric', 'checkbox', 'passFail']).optional(),
  fieldLabel: z.string().optional(),
  fieldRequired: z.boolean().optional(),
  fieldValidation: z
    .object({
      min: z.number().optional(),
      max: z.number().optional(),
      pattern: z.string().optional(),
    })
    .optional(),
})

// Step content schema
export const stepContentSchema = z.object({
  blocks: z.array(stepContentBlockSchema).default([]),
})

// Step validation schema
export const workInstructionStepSchema = z.object({
  id: z.string().uuid().optional(),
  workInstructionId: z.string().uuid(),
  operationId: z.string().uuid().nullable().optional(),
  orderIndex: z.number().int().min(0),
  title: z.string().max(500).optional(),
  content: stepContentSchema.default({ blocks: [] }),
})

// Part attachment schema
export const workInstructionPartAttachmentSchema = z.object({
  workInstructionId: z.string().uuid(),
  partId: z.string().uuid(),
  isOutput: z.boolean().default(false),
  inheritToMBOM: z.boolean().default(false),
})

// Change alert schema
export const workInstructionChangeAlertSchema = z.object({
  workInstructionId: z.string().uuid(),
  partId: z.string().uuid(),
  ecoId: z.string().uuid().nullable().optional(),
  changeType: z.enum(['part_modified', 'part_obsoleted', 'parametric_stale']),
  changedFields: z.array(z.string()).optional(),
  previousValues: z.record(z.string(), z.unknown()).optional(),
  newValues: z.record(z.string(), z.unknown()).optional(),
})

// WorkInstruction states - using standard lifecycle (Free type)
export const workInstructionStates = commonStates

// WorkInstruction relationships
export const workInstructionRelationships = [
  {
    type: 'Part',
    label: 'Attached Parts',
    targetTypes: ['Part'],
    allowMultiple: true,
  },
  {
    type: 'Document',
    label: 'Reference Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
]

// Execution types live with the work order domain now — executions are
// runs of traveler lines (work order instructions), not of templates.
// See @/lib/items/types/work-order.

// Export type for use in other modules
export type WorkInstructionInput = z.infer<typeof workInstructionSchema>
export type WorkInstructionStepInput = z.infer<typeof workInstructionStepSchema>
export type WorkInstructionOperationInput = z.infer<
  typeof workInstructionOperationSchema
>
