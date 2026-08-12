// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema } from './base'
import type { RelationshipConfig, StateConfig } from './base'
import type { InstructionSnapshot } from '@/lib/db/schema/work-orders'

export type { InstructionSnapshot }

/**
 * WorkOrder — an item type since Phase 2.5 (Tool pattern: non-versioned,
 * no designId, Free lifecycle). Identity rides the items row:
 * itemNumber = the WO-###### number, state = the status below.
 *
 * The legacy API/UI shape (workOrderNumber, status, createdAt, …) is
 * preserved by WorkOrderService, which maps item fields back onto it.
 */

export type WorkOrderStatus =
  'Not Started' | 'In Progress' | 'Complete' | 'Cancelled'

export type WorkOrderPriority = 'Low' | 'Normal' | 'High' | 'Urgent'

export interface WorkOrder {
  id: string
  workOrderNumber: string
  partId?: string | null
  quantity: number
  status: WorkOrderStatus
  priority: WorkOrderPriority
  dueDate?: string | Date | null
  customerOrder?: string | null
  notes?: string | null
  assignedTo?: Array<string>
  programId?: string | null
  quantityCompleted: number
  requiresSignOff: boolean
  completedAt?: string | Date | null
  createdAt: string | Date
  createdBy: string
  modifiedAt: string | Date
  modifiedBy: string
  // Populated from joins
  part?: {
    id: string
    itemNumber: string
    name?: string | null
    revision: string
  } | null
  program?: {
    id: string
    name: string
  } | null
}

/** Registry schema — validates the item-shaped payload ItemService sees. */
export const workOrderItemSchema = baseItemSchema.extend({
  itemType: z.literal('WorkOrder'),
  partId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().positive().default(1),
  quantityCompleted: z.number().int().nonnegative().default(0),
  priority: z.enum(['Low', 'Normal', 'High', 'Urgent']).default('Normal'),
  dueDate: z.union([z.string(), z.date()]).nullable().optional(),
  customerOrder: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  assignedTo: z.array(z.string()).default([]),
  programId: z.string().uuid().nullable().optional(),
  requiresSignOff: z.boolean().default(false),
  completedAt: z.union([z.string(), z.date()]).nullable().optional(),
})

export const workOrderStates: Array<StateConfig> = [
  { id: 'Not Started', name: 'Not Started', color: 'gray' },
  { id: 'In Progress', name: 'In Progress', color: 'blue' },
  { id: 'Complete', name: 'Complete', color: 'green' },
  { id: 'Cancelled', name: 'Cancelled', color: 'red' },
]

// Consumes/Produces edges are created by the material-consumption services,
// not the generic relationship picker.
export const workOrderRelationships: Array<RelationshipConfig> = []

export const workOrderCreateSchema = z.object({
  partId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().positive().default(1),
  priority: z.enum(['Low', 'Normal', 'High', 'Urgent']).default('Normal'),
  dueDate: z.string().nullable().optional(),
  customerOrder: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  assignedTo: z.array(z.string()).default([]),
  programId: z.string().uuid().nullable().optional(),
  requiresSignOff: z.boolean().default(false),
})

export const workOrderUpdateSchema = z.object({
  partId: z.string().uuid().nullable().optional(),
  quantity: z.number().int().positive().optional(),
  // Manually settable for lot/untracked parts; derived from produced units
  // for serial-tracked parts (WorkOrderMaterialService.produce).
  quantityCompleted: z.number().int().nonnegative().optional(),
  priority: z.enum(['Low', 'Normal', 'High', 'Urgent']).optional(),
  dueDate: z.string().nullable().optional(),
  customerOrder: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  assignedTo: z.array(z.string()).optional(),
  programId: z.string().uuid().nullable().optional(),
  requiresSignOff: z.boolean().optional(),
})

export type WorkOrderCreateInput = z.infer<typeof workOrderCreateSchema>
export type WorkOrderUpdateInput = z.infer<typeof workOrderUpdateSchema>

// =====================================================================
// Traveler: work order instructions (instances of WI templates) and
// their executions. See docs/proposals/work-order-traveler.md.
// =====================================================================

/** Derived from executions — never stored. */
export type WorkOrderInstructionStatus =
  'Not Started' | 'In Progress' | 'Complete' | 'Skipped'

export interface WorkOrderInstruction {
  id: string
  workOrderId: string
  /** Provenance; null once the template is deleted. */
  workInstructionId: string | null
  partId: string | null
  orderIndex: number
  title: string
  instructionNumber: string | null
  instructionRevision: string | null
  snapshot: InstructionSnapshot
  snapshotAt: string | Date
  requiredCount: number
  skippedAt?: string | Date | null
  skippedBy?: string | null
  skipReason?: string | null
  createdAt: string | Date
  createdBy: string
  // Derived / joined
  status: WorkOrderInstructionStatus
  completedCount: number
  executionCount: number
  part?: {
    id: string
    itemNumber: string
    name?: string | null
    revision: string
  } | null
}

export type ExecutionStatus =
  | 'In Progress'
  | 'Complete'
  | 'Incomplete'
  | 'Pending Approval'
  | 'Approved'
  | 'Rejected'

/** Execution statuses that count toward a traveler line's requiredCount. */
export const COUNTABLE_EXECUTION_STATUSES: ReadonlyArray<ExecutionStatus> = [
  'Complete',
  'Approved',
]

export interface InstructionExecution {
  id: string
  workOrderInstructionId: string
  executedBy: string
  unitLabel?: string | null
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
  instruction?: {
    id: string
    title: string
    workOrderId: string
  } | null
  workOrder?: {
    id: string
    workOrderNumber: string
  } | null
}

export const instantiateInstructionSchema = z
  .object({
    workInstructionId: z.string().uuid(),
    partId: z.string().uuid().nullable().optional(),
    requiredCount: z.number().int().positive().optional(),
    /** Pin requiredCount to the order quantity (per-unit step). */
    perUnit: z.boolean().optional(),
  })
  .refine((v) => !(v.perUnit && v.requiredCount !== undefined), {
    message: 'Provide either perUnit or requiredCount, not both',
  })

export const reorderInstructionsSchema = z.object({
  instructions: z
    .array(
      z.object({
        id: z.string().uuid(),
        orderIndex: z.number().int().min(0),
      }),
    )
    .min(1),
})

export const updateInstructionSchema = z.object({
  requiredCount: z.number().int().positive(),
})

export const skipInstructionSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required to skip'),
})

export const startExecutionSchema = z.object({
  unitLabel: z.string().trim().max(200).optional(),
})

export type InstantiateInstructionInput = z.infer<
  typeof instantiateInstructionSchema
>
export type ReorderInstructionsInput = z.infer<typeof reorderInstructionsSchema>
