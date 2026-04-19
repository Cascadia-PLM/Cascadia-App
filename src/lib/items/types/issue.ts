import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

// Issue severity levels
export const issueSeverities = ['Critical', 'High', 'Medium', 'Low'] as const
export type IssueSeverity = (typeof issueSeverities)[number]

// Issue priority levels
export const issuePriorities = ['Critical', 'High', 'Medium', 'Low'] as const
export type IssuePriority = (typeof issuePriorities)[number]

// Issue categories (PLM standard)
export const issueCategories = [
  'Design',
  'Manufacturing',
  'Quality',
  'Customer',
  'Safety',
  'Other',
] as const
export type IssueCategory = (typeof issueCategories)[number]

// Issue-specific interface
export interface Issue extends BaseItem {
  itemType: 'Issue'
  description?: string
  severity?: IssueSeverity
  priority?: IssuePriority
  category?: IssueCategory
  reportedBy?: string
  reportedDate?: Date | string
  assignedTo?: string
  resolution?: string
  resolvedDate?: Date | string
  rootCause?: string
  /** Computed from issue_affected_items junction table */
  affectedItemIds?: Array<string>
  programId?: string
  /** Computed from issue_designs junction table */
  designIds?: Array<string>
}

// Issue validation schema
export const issueSchema = baseItemSchema.extend({
  itemType: z.literal('Issue'),
  description: z.string().max(10000).optional(),
  severity: z.enum(issueSeverities).optional().default('Medium'),
  priority: z.enum(issuePriorities).optional().default('Medium'),
  category: z.enum(issueCategories).optional(),
  reportedBy: z.string().uuid().optional(),
  reportedDate: z.union([z.string(), z.date()]).optional(),
  assignedTo: z.string().uuid().optional(),
  resolution: z.string().max(10000).optional(),
  resolvedDate: z.union([z.string(), z.date()]).optional(),
  rootCause: z.string().max(10000).optional(),
  affectedItemIds: z.array(z.string().uuid()).optional(),
  programId: z.string().uuid().optional(),
  designIds: z.array(z.string().uuid()).optional(),
})

// Issue states (Free lifecycle - self-controlled)
export const issueStates = [
  {
    id: 'Open',
    name: 'Open',
    color: 'blue',
    description: 'Issue has been reported and is awaiting triage',
  },
  {
    id: 'InProgress',
    name: 'In Progress',
    color: 'yellow',
    description: 'Issue is being actively investigated or worked on',
  },
  {
    id: 'Pending',
    name: 'Pending',
    color: 'orange',
    description: 'Issue is waiting for external input or action',
  },
  {
    id: 'Resolved',
    name: 'Resolved',
    color: 'green',
    description: 'Issue has been resolved but not yet verified',
  },
  {
    id: 'Verified',
    name: 'Verified',
    color: 'emerald',
    description: 'Resolution has been verified and confirmed',
  },
  {
    id: 'Closed',
    name: 'Closed',
    color: 'slate',
    description: 'Issue is closed and complete',
  },
  {
    id: 'Cancelled',
    name: 'Cancelled',
    color: 'red',
    description: 'Issue was cancelled (duplicate, invalid, etc.)',
  },
]

// Issue relationships
export const issueRelationships = [
  {
    type: 'AffectedItem',
    label: 'Affected Items',
    targetTypes: ['Part', 'Document'],
    allowMultiple: true,
  },
  {
    type: 'RelatedIssue',
    label: 'Related Issues',
    targetTypes: ['Issue'],
    allowMultiple: true,
  },
  {
    type: 'CausedBy',
    label: 'Caused By',
    targetTypes: ['ChangeOrder', 'Issue'],
    allowMultiple: true,
  },
  {
    type: 'ResolvedBy',
    label: 'Resolved By',
    targetTypes: ['ChangeOrder'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type IssueInput = z.infer<typeof issueSchema>
