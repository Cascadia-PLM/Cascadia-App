import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem, StateConfig } from './base'

// Test plan status types
export type TestPlanStatus = 'Draft' | 'Active' | 'Completed' | 'Archived'

// TestPlan-specific interface
export interface TestPlan extends BaseItem {
  itemType: 'TestPlan'
  designId: string // Required for TestPlans - links to versioning system
  scope?: string
  environment?: string
  entryCriteria?: string
  exitCriteria?: string
  status?: TestPlanStatus
}

// TestPlan validation schema
export const testPlanSchema = baseItemSchema.extend({
  itemType: z.literal('TestPlan'),
  designId: z.string().uuid({ message: 'Design is required' }),
  scope: z.string().max(5000).optional(),
  environment: z.string().max(100).optional(),
  entryCriteria: z.string().max(5000).optional(),
  exitCriteria: z.string().max(5000).optional(),
  status: z.enum(['Draft', 'Active', 'Completed', 'Archived']).optional(),
})

// TestPlan-specific states (defined explicitly rather than spreading commonStates)
export const testPlanStates: Array<StateConfig> = [
  {
    id: 'Draft',
    name: 'Draft',
    color: 'gray',
    description: 'Test plan is being created or edited',
  },
  {
    id: 'Active',
    name: 'Active',
    color: 'blue',
    description: 'Test plan is currently being executed',
  },
  {
    id: 'Completed',
    name: 'Completed',
    color: 'green',
    description: 'Test plan execution is complete',
  },
  {
    id: 'Archived',
    name: 'Archived',
    color: 'gray',
    description: 'Test plan has been archived',
  },
  {
    id: 'Obsolete',
    name: 'Obsolete',
    color: 'red',
    description: 'Test plan is no longer used',
  },
]

// TestPlan relationships
export const testPlanRelationships = [
  {
    type: 'TestCase',
    label: 'Test Cases',
    targetTypes: ['TestCase'],
    allowMultiple: true,
  },
  {
    type: 'Requirement',
    label: 'Related Requirements',
    targetTypes: ['Requirement'],
    allowMultiple: true,
  },
  {
    type: 'Document',
    label: 'Related Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type TestPlanInput = z.infer<typeof testPlanSchema>
