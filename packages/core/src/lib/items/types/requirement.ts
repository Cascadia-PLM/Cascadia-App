// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema, commonStates } from './base'
import type { BaseItem } from './base'

// Verification method types for requirements
export type VerificationMethod =
  'Analysis' | 'Inspection' | 'Demonstration' | 'Test' | 'Documentation'

// Verification status for requirements
export type VerificationStatus =
  'NotStarted' | 'InProgress' | 'Passed' | 'Failed' | 'Waived'

// Requirement classification. Exported as a schema (not just a union) because
// the AI/MCP `create_item` tool advertises these values to models — deriving
// its enum from here is what keeps the two from drifting apart, which is how
// three never-valid values ended up in the tool schema.
export const requirementTypeSchema = z.enum([
  'Functional',
  'Non-Functional',
  'Performance',
  'Security',
  'Usability',
  'Business',
])
export type RequirementType = z.infer<typeof requirementTypeSchema>

export const requirementPrioritySchema = z.enum([
  'MustHave',
  'ShouldHave',
  'CouldHave',
  'WontHave',
])
export type RequirementPriority = z.infer<typeof requirementPrioritySchema>

// Requirement-specific interface
export interface Requirement extends BaseItem {
  itemType: 'Requirement'
  designId: string // Required for Requirements - links to versioning system
  description?: string
  type?: RequirementType
  priority?: RequirementPriority
  acceptanceCriteria?: string
  source?: string
  category?: string
  // Phase 2: Verification and traceability fields
  verificationMethod?: VerificationMethod
  verificationStatus?: VerificationStatus
  allocatedDesignId?: string
  parentRequirementId?: string
}

// Requirement validation schema
export const requirementSchema = baseItemSchema.extend({
  itemType: z.literal('Requirement'),
  designId: z.string().uuid({ message: 'Design is required' }), // Required for Requirements
  description: z.string().max(5000).optional(),
  type: requirementTypeSchema.optional(),
  priority: requirementPrioritySchema.optional(),
  acceptanceCriteria: z.string().max(5000).optional(),
  source: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  // Phase 2: Verification and traceability fields
  verificationMethod: z
    .enum(['Analysis', 'Inspection', 'Demonstration', 'Test', 'Documentation'])
    .optional(),
  verificationStatus: z
    .enum(['NotStarted', 'InProgress', 'Passed', 'Failed', 'Waived'])
    .optional(),
  allocatedDesignId: z.string().uuid().optional(),
  parentRequirementId: z.string().uuid().optional(),
})

// Requirements are versioned, ECO-driven items like Parts and Documents.
// Review progress (Proposed/Approved/Rejected in the default lifecycle) is
// part of the lifecycle itself — manual pre-release transitions — and release
// maps Approved → Released; the old `status` field is gone. Verification
// outcome stays the measured `verificationStatus`.
export const requirementStates = commonStates

// Requirement relationships
export const requirementRelationships = [
  {
    type: 'Part',
    label: 'Related Parts',
    targetTypes: ['Part'],
    allowMultiple: true,
  },
  {
    type: 'Document',
    label: 'Related Documents',
    targetTypes: ['Document'],
    allowMultiple: true,
  },
  {
    type: 'Dependency',
    label: 'Dependencies',
    targetTypes: ['Requirement'],
    allowMultiple: true,
  },
]

// Export type for use in other modules
export type RequirementInput = z.infer<typeof requirementSchema>
