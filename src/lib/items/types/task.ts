import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

// Task-specific interface
export interface Task extends BaseItem {
  itemType: 'Task'
  programId?: string
  parentTaskId?: string
  description?: string
  assignee?: string
  priority?: 'Low' | 'Medium' | 'High' | 'Critical'
  dueDate?: Date | string
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
  priority: z
    .enum(['Low', 'Medium', 'High', 'Critical'])
    .optional()
    .default('Medium'),
  dueDate: z.union([z.string(), z.date()]).optional(),
  estimatedHours: z.string().optional(),
  actualHours: z.string().optional(),
  tags: z.array(z.string()).optional(),
})

// Task-specific states for Kanban
export const taskStates = [
  {
    id: 'Backlog',
    name: 'Backlog',
    color: 'slate',
    description: 'Task is in the backlog',
  },
  {
    id: 'ToDo',
    name: 'To Do',
    color: 'blue',
    description: 'Task is ready to be started',
  },
  {
    id: 'InProgress',
    name: 'In Progress',
    color: 'yellow',
    description: 'Task is being worked on',
  },
  {
    id: 'InReview',
    name: 'In Review',
    color: 'purple',
    description: 'Task is being reviewed',
  },
  { id: 'Done', name: 'Done', color: 'green', description: 'Task is complete' },
  {
    id: 'Cancelled',
    name: 'Cancelled',
    color: 'red',
    description: 'Task was cancelled',
  },
]

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
