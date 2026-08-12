// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { z } from 'zod'
import { baseItemSchema } from './base'
import type { BaseItem } from './base'

// Change action types.
//
// Every action changes an item's lifecycle state. BOM membership is NOT a
// change action: it is edited on the change order's branch (via
// `POST /change-orders/:id/bom-changes`) and released when the branch merges,
// because the merge replaces the released item's structure with the branch's.
// 'add' and 'remove' used to sit here as a second, parallel way to say the
// same thing — and did nothing at merge, so a workspace item converted to a
// change order as 'add' was silently never released.
export const changeActionSchema = z.enum([
  'release',
  'revise',
  'obsolete',
  'promote',
])
export type ChangeAction = z.infer<typeof changeActionSchema>

/**
 * Display labels for change actions. Client-safe, and the only presentational
 * thing about a change action that lives outside the lifecycle — the valid
 * action set, target state and target revision all come from the server
 * (`ChangeOrderService.getChangeActionOptions`).
 */
export const CHANGE_ACTION_LABELS: Record<ChangeAction, string> = {
  release: 'Release',
  revise: 'Revise',
  obsolete: 'Obsolete',
  promote: 'Promote',
}

/**
 * What adding one item to a change order would do, resolved server-side from
 * the item's lifecycle. `targetRevision` is a prediction: for `revise` the
 * merge recomputes it against main's current version at release time.
 */
export interface ChangeActionOptions {
  itemId: string
  itemNumber: string
  currentState: string
  currentRevision: string
  actions: Array<{
    action: ChangeAction
    label: string
    targetState: string | null
    targetRevision: string | null
  }>
  defaultAction: ChangeAction | null
  /** Set when the item cannot be added at all, with the reason to show */
  blockedReason?: string
}

// Change order priority
export const changeOrderPrioritySchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
])
export type ChangeOrderPriority = z.infer<typeof changeOrderPrioritySchema>

// Change order types
export const changeOrderTypeSchema = z.enum([
  'ECO',
  'ECN',
  'Deviation',
  'MCO',
  'XCO',
])
export type ChangeOrderType = z.infer<typeof changeOrderTypeSchema>

// Risk levels
export const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical'])
export type RiskLevel = z.infer<typeof riskLevelSchema>

// Impact assessment status
export const impactAssessmentStatusSchema = z.enum([
  'pending',
  'in_progress',
  'completed',
  'failed',
])
export type ImpactAssessmentStatus = z.infer<
  typeof impactAssessmentStatusSchema
>

// ChangeOrder-specific interface
export interface ChangeOrder extends BaseItem {
  itemType: 'ChangeOrder'
  changeType: ChangeOrderType
  priority?: ChangeOrderPriority
  description?: string // General description (optional, separate from reasonForChange)
  reasonForChange?: string
  impactDescription?: string
  implementationDate?: Date | string
  submittedAt?: Date | string
  approvedAt?: Date | string
  approvedBy?: string
  implementedAt?: Date | string
  closedAt?: Date | string
  impactAssessmentStatus?: ImpactAssessmentStatus
  riskLevel?: RiskLevel
  // Baseline creation on release
  isBaseline?: boolean
  baselineName?: string
}

// ChangeOrder validation schema
export const changeOrderSchema = baseItemSchema.extend({
  itemType: z.literal('ChangeOrder'),
  changeType: changeOrderTypeSchema,
  priority: changeOrderPrioritySchema.optional(),
  description: z.string().max(10000).optional(),
  reasonForChange: z.string().max(10000).optional(),
  impactDescription: z.string().max(10000).optional(),
  implementationDate: z.union([z.date(), z.string()]).optional(),
  submittedAt: z.union([z.date(), z.string()]).optional(),
  approvedAt: z.union([z.date(), z.string()]).optional(),
  approvedBy: z.string().uuid().optional(),
  implementedAt: z.union([z.date(), z.string()]).optional(),
  closedAt: z.union([z.date(), z.string()]).optional(),
  impactAssessmentStatus: impactAssessmentStatusSchema.optional(),
  riskLevel: riskLevelSchema.optional(),
  // Baseline creation on release
  isBaseline: z.boolean().optional(),
  baselineName: z.string().max(100).optional(),
})

// Change order states
export const changeOrderStates = [
  {
    id: 'Draft',
    name: 'Draft',
    color: 'gray',
    description: 'Change order is being drafted',
  },
  {
    id: 'Submitted',
    name: 'Submitted',
    color: 'blue',
    description: 'Change order has been submitted',
  },
  {
    id: 'ImpactAssessment',
    name: 'Impact Assessment',
    color: 'indigo',
    description: 'Impact assessment in progress',
  },
  {
    id: 'Review',
    name: 'Review',
    color: 'yellow',
    description: 'Change order under review',
  },
  {
    id: 'Approved',
    name: 'Approved',
    color: 'green',
    description: 'Change order approved',
  },
  {
    id: 'Rejected',
    name: 'Rejected',
    color: 'red',
    description: 'Change order rejected',
  },
  {
    id: 'Implementation',
    name: 'Implementation',
    color: 'purple',
    description: 'Change order being implemented',
  },
  {
    id: 'Implemented',
    name: 'Implemented',
    color: 'cyan',
    description: 'Change order implemented',
  },
  {
    id: 'Closed',
    name: 'Closed',
    color: 'slate',
    description: 'Change order closed',
  },
]

// Affected item schema
export const affectedItemSchema = z.object({
  id: z.string().uuid().optional(),
  changeOrderId: z.string().uuid(),
  affectedItemId: z.string().uuid().nullable(),
  affectedItemMasterId: z.string().uuid().nullable(),
  changeAction: changeActionSchema,
  // The working copy checked out for this affected item (branch_items row),
  // present on the persisted record returned by addAffectedItem.
  workingCopyId: z.string().uuid().nullable().optional(),
  currentState: z.string().max(50).nullable(),
  currentRevision: z.string().max(10).nullable(),
  targetState: z.string().max(50).nullable(),
  targetRevision: z.string().max(10).nullable(),
  replacementItemId: z.string().uuid().nullable(),
  newItemData: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .nullable(),
  newItemType: z.string().max(50).nullable(),
  changeDescription: z.string().max(5000).nullable(),
  isDirectlyAffected: z.boolean().default(true),
})

export type AffectedItem = z.infer<typeof affectedItemSchema>

// Impacted item schema (discovered by impact analysis)
export const impactedItemSchema = z.object({
  id: z.string().uuid().optional(),
  changeOrderId: z.string().uuid(),
  impactedItemId: z.string().uuid(),
  impactType: z.enum([
    'where_used',
    'document_reference',
    'bom_child',
    'related_change',
  ]),
  impactSeverity: z.enum(['low', 'medium', 'high']).optional(),
  depth: z.number().int().optional(),
  path: z.array(z.string().uuid()).optional(),
  metadata: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional(),
})

export type ImpactedItem = z.infer<typeof impactedItemSchema>

// Risk schema
export const riskSchema = z.object({
  id: z.string().uuid().optional(),
  changeOrderId: z.string().uuid(),
  category: z.enum([
    'inventory',
    'production',
    'cost',
    'schedule',
    'compliance',
    'quality',
    'cross-design',
  ]),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  description: z.string().max(5000),
  affectedItems: z.array(z.string()).optional(),
  mitigation: z.string().max(5000).optional(),
  requiresAcknowledgement: z.boolean().default(false),
  acknowledgedBy: z.string().uuid().nullable(),
  acknowledgedAt: z.union([z.date(), z.string()]).nullable(),
})

export type Risk = z.infer<typeof riskSchema>

// Impact report schema
export const impactReportSchema = z.object({
  id: z.string().uuid().optional(),
  changeOrderId: z.string().uuid(),
  generatedAt: z.union([z.date(), z.string()]),
  totalImpactedItems: z.number().int(),
  maxBOMDepth: z.number().int(),
  reportData: z.record(z.string(), z.unknown()),
  generationDurationMs: z.number().int(),
})

export type ImpactReport = z.infer<typeof impactReportSchema>

// Change order relationships
export const changeOrderRelationships = [
  {
    type: 'Affects',
    label: 'Affected Items',
    targetTypes: ['Part', 'Document', 'ChangeOrder'],
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
export type ChangeOrderInput = z.infer<typeof changeOrderSchema>
