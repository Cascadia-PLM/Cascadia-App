// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

// Task priority. Exported as a schema so the AI/MCP tool schemas can advertise
// exactly the values this type accepts (see requirement.ts).
export const taskPrioritySchema = z.enum(['Low', 'Medium', 'High', 'Critical'])
export type TaskPriority = z.infer<typeof taskPrioritySchema>

// Task-specific interface
export interface Task extends BaseItem {
  itemType: 'Task'
  programId?: string
  parentTaskId?: string
  description?: string
  assignee?: string
  priority?: TaskPriority
  dueDate?: Date | string | null
  estimatedHours?: string
  actualHours?: string
  tags?: Array<string>
}

// Task validation schema
export const taskSchema = baseItemSchema.extend({
  itemType: z.literal('Task'),
  programId: z.string().uuid().optional(),
  parentTaskId: z.string().uuid().optional(),
  description: z.string().max(5000).optional(),
  assignee: z.string().uuid().optional(),
  priority: taskPrioritySchema.optional().default('Medium'),
  dueDate: z.union([z.string(), z.date()]).nullable().optional(),
  estimatedHours: z.string().optional(),
  actualHours: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

// Task relationships
export const taskRelationships = [
  {
    type: 'Blocker',
    label: 'Blocked By',
    targetTypes: ['Task'],
    allowMultiple: true,
  },
  {
    type: 'Dependency',
    label: 'Depends On',
    targetTypes: ['Task'],
    allowMultiple: true,
  },
  {
    type: 'Document',
    label: 'Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type TaskInput = z.infer<typeof taskSchema>
