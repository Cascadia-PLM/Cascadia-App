// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

// TestPlan-specific interface. The flow position (Draft/Active/Completed/
// Archived in the default lifecycle) is the item's lifecycle `state`; the
// old duplicate `status` field is gone.
export interface TestPlan extends BaseItem {
  itemType: 'TestPlan'
  designId: string // Required for TestPlans - links to versioning system
  scope?: string
  environment?: string
  entryCriteria?: string
  exitCriteria?: string
}

// TestPlan validation schema
export const testPlanSchema = baseItemSchema.extend({
  itemType: z.literal('TestPlan'),
  designId: z.string().uuid({ message: 'Design is required' }),
  scope: z.string().max(5000).optional(),
  environment: z.string().max(100).optional(),
  entryCriteria: z.string().max(5000).optional(),
  exitCriteria: z.string().max(5000).optional(),
})

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
