import { z } from 'zod'

export type WorkOrderStatus =
  | 'Not Started'
  | 'In Progress'
  | 'Complete'
  | 'Cancelled'

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
