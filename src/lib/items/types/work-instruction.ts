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

// WorkInstruction validation schema
export const workInstructionSchema = baseItemSchema.extend({
  itemType: z.literal('WorkInstruction'),
  description: z.string().max(5000).optional(),
  estimatedTime: z.number().int().positive().optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).optional(),
  safetyNotes: z.string().max(5000).optional(),
  requiredTools: z.string().max(2000).optional(),
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

// Execution types
export type ExecutionStatus =
  | 'In Progress'
  | 'Complete'
  | 'Incomplete'
  | 'Pending Approval'
  | 'Approved'
  | 'Rejected'

export const executionStatusSchema = z.enum([
  'In Progress',
  'Complete',
  'Incomplete',
  'Pending Approval',
  'Approved',
  'Rejected',
])

export interface WorkInstructionExecution {
  id: string
  workInstructionId: string
  workInstructionRevision?: string | null
  workOrderId?: string | null
  executedBy: string
  status: ExecutionStatus
  startedAt: string | Date
  completedAt?: string | Date | null
  duration?: number | null // seconds
  stepData: Record<
    string,
    {
      value: unknown
      capturedAt: string
      blockId: string
    }
  >
  notes?: string | null
  currentStepIndex: number
  // Populated from joins
  executor?: {
    id: string
    name: string
    email: string
  }
  workOrder?: {
    id: string
    workOrderNumber: string
  } | null
}

// Export type for use in other modules
export type WorkInstructionInput = z.infer<typeof workInstructionSchema>
export type WorkInstructionStepInput = z.infer<typeof workInstructionStepSchema>
export type WorkInstructionOperationInput = z.infer<
  typeof workInstructionOperationSchema
>
