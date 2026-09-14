// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

// Test type categories
export type TestType = 'Unit' | 'Integration' | 'System' | 'Acceptance'

// Execution status for test cases
export type ExecutionStatus = 'NotRun' | 'Passed' | 'Failed' | 'Blocked'

// Test step structure
export interface TestStep {
  stepNumber: number
  action: string
  expectedResult: string
}

// Test step schema for validation
export const testStepSchema = z.object({
  stepNumber: z.number().int().min(1),
  action: z.string().min(1).max(2000),
  expectedResult: z.string().min(1).max(2000),
})

// TestCase-specific interface
export interface TestCase extends BaseItem {
  itemType: 'TestCase'
  designId: string // Required for TestCases - links to versioning system
  testPlanId?: string // Link to parent TestPlan
  testType?: TestType
  preconditions?: string
  steps?: Array<TestStep>
  executionStatus?: ExecutionStatus
  lastExecutedAt?: Date | null
  lastExecutedBy?: string
  environment?: string
}

// TestCase validation schema
export const testCaseSchema = baseItemSchema.extend({
  itemType: z.literal('TestCase'),
  designId: z.string().uuid({ message: 'Design is required' }),
  testPlanId: z.string().uuid().optional(),
  testType: z.enum(['Unit', 'Integration', 'System', 'Acceptance']).optional(),
  preconditions: z.string().max(5000).optional(),
  steps: z.array(testStepSchema).optional(),
  executionStatus: z.enum(['NotRun', 'Passed', 'Failed', 'Blocked']).optional(),
  lastExecutedAt: z.date().nullable().optional(),
  lastExecutedBy: z.string().uuid().optional(),
  environment: z.string().max(100).optional(),
})

// TestCase relationships
export const testCaseRelationships = [
  {
    type: 'VERIFIED_BY',
    label: 'Verifies Requirements',
    targetTypes: ['Requirement'],
    allowMultiple: true,
  },
  {
    type: 'VALIDATES',
    label: 'Validates Parts',
    targetTypes: ['Part'],
    allowMultiple: true,
  },
  {
    type: 'TestPlan',
    label: 'Parent Test Plan',
    targetTypes: ['TestPlan'],
    allowMultiple: false,
  },
  {
    type: 'Document',
    label: 'Related Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type TestCaseInput = z.infer<typeof testCaseSchema>
