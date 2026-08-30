// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * API Request/Response Schemas
 *
 * This module provides separated Create and Update schemas for all resources.
 * Create schemas have required fields, Update schemas make all fields optional
 * for PATCH-style partial updates.
 *
 * Follows the pattern established in ProgramService and DesignService.
 */

import { z } from 'zod'
import { changeOrderTypeSchema } from '@/lib/items/types/change-order'
import { testStepSchema } from '@/lib/items/types/testcase'
import {
  issueCategories,
  issuePriorities,
  issueSeverities,
} from '@/lib/items/types/issue'
import { workOrderUpdateSchema } from '@/lib/items/types/work-order'

// =============================================================================
// User Schemas
// =============================================================================

/**
 * User create/update schemas live in `lib/auth/types.ts`, not here.
 *
 * A second pair used to sit in this file with a `passwordConfirm` field and no
 * `provider`/`active`. Nothing enforced it — `UserService` parses the
 * `lib/auth/types` pair, and `UserForm` validates against the same — so the
 * copy here was a shape that had never matched the API's actual contract. It
 * is gone rather than reconciled: one schema per resource is the whole point.
 */

// =============================================================================
// Part Schemas
// =============================================================================

/**
 * Schema for creating a new part.
 */
export const partCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  // Server-assigned when omitted: an item has no revision until a release
  // assigns one. See `baseItemSchema.revision`.
  revision: z.string().min(1).max(10).optional(),
  name: z.string().max(500).optional(),
  designId: z.string().uuid('Design is required'),
  description: z.string().max(5000).optional(),
  partType: z
    .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
    .optional(),
  trackingMode: z.enum(['none', 'lot', 'serial']).optional(),
  material: z.string().max(100).optional(),
  weight: z.string().optional(),
  weightUnit: z.string().max(10).optional().default('kg'),
  cost: z.string().optional(),
  costCurrency: z.string().length(3).optional().default('USD'),
  leadTimeDays: z.number().int().min(0).optional(),
  branchId: z.string().uuid().optional(), // For versioned workflow
})

/**
 * Schema for updating a part.
 *
 * All fields optional for PATCH-style updates — and `null` is accepted
 * wherever the column is nullable, because that is how the edit form clears a
 * field and how a read hands the value back. The detail page echoes the whole
 * part (`{ ...part, attributes }`), so anything a read can return this must
 * accept, or saving an untouched part becomes a 400.
 *
 * What is deliberately absent is what `ItemService.update` never writes
 * (`itemNumber`, timestamps, lock state) or refuses to change (`revision`,
 * `isCurrent`, `designId`). Those are stripped now rather than travelling
 * into the service to be ignored or rejected there.
 */
export const partUpdateSchema = z.object({
  name: z.string().max(500).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  partType: z
    .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
    .nullable()
    .optional(),
  // NOT NULL with a default in the database, so a read never returns null.
  trackingMode: z.enum(['none', 'lot', 'serial']).optional(),
  material: z.string().max(100).nullable().optional(),
  weight: z.string().nullable().optional(),
  weightUnit: z.string().max(10).nullable().optional(),
  cost: z.string().nullable().optional(),
  costCurrency: z.string().length(3).nullable().optional(),
  leadTimeDays: z.number().int().min(0).nullable().optional(),
  // Echoed by whole-item form saves. `ItemService.update` tolerates an
  // identical value and rejects a changed one — a state change goes through
  // the lifecycle, not through here.
  state: z.string().max(50).optional(),
  // Free-form extension bag on the items row. Typed `Record<string, unknown>`
  // in the schema, so the values are not narrowed to strings here either: a
  // PUT echoes back whatever a read returned.
  attributes: z.record(z.string(), z.unknown()).optional(),
  commitMessage: z.string().max(500).optional(),
})

export type PartCreate = z.infer<typeof partCreateSchema>
export type PartUpdate = z.infer<typeof partUpdateSchema>

// =============================================================================
// Document Schemas
// =============================================================================

/**
 * Schema for creating a new document.
 */
export const documentCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  // Server-assigned when omitted: an item has no revision until a release
  // assigns one. See `baseItemSchema.revision`.
  revision: z.string().min(1).max(10).optional(),
  name: z.string().max(500).optional(),
  designId: z.string().uuid('Design is required'),
  description: z.string().max(5000).optional(),
  fileId: z.string().uuid().optional(),
  fileName: z.string().max(500).optional(),
  fileSize: z.number().int().min(0).optional(),
  mimeType: z.string().max(100).optional(),
  branchId: z.string().uuid().optional(),
})

/**
 * Schema for updating a document.
 */
export const documentUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  fileId: z.string().uuid().optional(),
  fileName: z.string().max(500).optional(),
  state: z.string().max(50).optional(),
  commitMessage: z.string().max(500).optional(),
})

export type DocumentCreate = z.infer<typeof documentCreateSchema>
export type DocumentUpdate = z.infer<typeof documentUpdateSchema>

// =============================================================================
// Requirement Schemas
// =============================================================================

export const requirementPrioritySchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
])
export const verificationMethodSchema = z.enum([
  'inspection',
  'analysis',
  'demonstration',
  'test',
  'documentation',
])

/**
 * Schema for creating a new requirement.
 */
export const requirementCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  // Server-assigned when omitted: an item has no revision until a release
  // assigns one. See `baseItemSchema.revision`.
  revision: z.string().min(1).max(10).optional(),
  name: z.string().max(500).optional(),
  designId: z.string().uuid('Design is required'),
  requirementType: z.string().max(50).optional(),
  description: z.string().max(10000).optional(),
  priority: requirementPrioritySchema.optional(),
  verificationMethod: verificationMethodSchema.optional(),
  acceptanceCriteria: z.string().max(10000).optional(),
  branchId: z.string().uuid().optional(),
})

/**
 * Schema for updating a requirement.
 */
export const requirementUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  // The column is `type`; `requirementType` is the older API spelling and is
  // kept as an alias, resolved in items/type-handlers/requirement.ts. Neither
  // is narrowed to an enum - the column is a plain varchar(50).
  type: z.string().max(50).optional(),
  requirementType: z.string().max(50).optional(),
  description: z.string().max(10000).optional(),
  priority: requirementPrioritySchema.optional(),
  verificationMethod: verificationMethodSchema.optional(),
  acceptanceCriteria: z.string().max(10000).optional(),
  state: z.string().max(50).optional(),
  commitMessage: z.string().max(500).optional(),
})

export type RequirementCreate = z.infer<typeof requirementCreateSchema>
export type RequirementUpdate = z.infer<typeof requirementUpdateSchema>

// =============================================================================
// Task Schemas
// =============================================================================

export const taskPrioritySchema = z.enum(['low', 'medium', 'high', 'critical'])

/**
 * Schema for creating a new task.
 */
export const taskCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  // Server-assigned when omitted: an item has no revision until a release
  // assigns one. See `baseItemSchema.revision`.
  revision: z.string().min(1).max(10).optional(),
  name: z.string().max(500).optional(),
  designId: z.string().uuid().optional(), // Optional for tasks
  description: z.string().max(10000).optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.coerce.date().optional(),
  assignee: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
})

/**
 * Schema for updating a task.
 */
export const taskUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  description: z.string().max(10000).optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.coerce.date().optional(),
  assignee: z.string().uuid().optional(),
  state: z.string().max(50).optional(),
  commitMessage: z.string().max(500).optional(),
})

export type TaskCreate = z.infer<typeof taskCreateSchema>
export type TaskUpdate = z.infer<typeof taskUpdateSchema>

// =============================================================================
// Change Order Schemas
// =============================================================================

export { changeOrderTypeSchema }
export const changeOrderPrioritySchema = z.enum([
  'low',
  'medium',
  'high',
  'critical',
])
export const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical'])

/**
 * Schema for creating a new change order.
 */
export const changeOrderCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  // Server-assigned when omitted: an item has no revision until a release
  // assigns one. See `baseItemSchema.revision`.
  revision: z.string().min(1).max(10).optional(),
  name: z.string().max(500).optional(),
  changeType: changeOrderTypeSchema,
  priority: changeOrderPrioritySchema.optional(),
  description: z.string().max(10000).optional(),
  reasonForChange: z.string().max(10000).optional(),
  impactDescription: z.string().max(10000).optional(),
  implementationDate: z.coerce.date().optional(),
  riskLevel: riskLevelSchema.optional(),
})

/**
 * Schema for updating a change order.
 */
export const changeOrderUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  changeType: changeOrderTypeSchema.optional(),
  priority: changeOrderPrioritySchema.optional(),
  description: z.string().max(10000).optional(),
  reasonForChange: z.string().max(10000).optional(),
  impactDescription: z.string().max(10000).optional(),
  implementationDate: z.coerce.date().optional(),
  riskLevel: riskLevelSchema.optional(),
  state: z.string().max(50).optional(),
  commitMessage: z.string().max(500).optional(),
})

export type ChangeOrderCreate = z.infer<typeof changeOrderCreateSchema>
export type ChangeOrderUpdate = z.infer<typeof changeOrderUpdateSchema>

// =============================================================================
// Per-type update schemas for the generic PUT /items/:id
//
// The generic item update serves every registered type, so its body schema is
// resolved at request time from the stored item's type — a static union here
// would reject nothing (every field optional in some branch) and document a
// shape no single request has.
//
// Conventions, following partUpdateSchema above: every field optional
// (PATCH-style), `null` accepted wherever the column is nullable — the detail
// pages echo whole read payloads back, so anything a read can return must
// parse. `state` stays optional (ItemService.update tolerates an echoed
// identical value and rejects a changed one). Server-managed fields — identity
// columns, flow-managed pointers like a software item's manifest ids or a
// physical part's as-built pin — are deliberately absent: they are stripped
// here rather than travelling into the service to be ignored or rejected.
// =============================================================================

/** Base-item fields every type's update accepts. */
const itemUpdateBaseFields = {
  name: z.string().max(500).nullable().optional(),
  state: z.string().max(50).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  commitMessage: z.string().max(500).optional(),
}

/**
 * Fallback for an item type without a dedicated update schema. Base fields
 * only — the parameterized test over `ITEM_TYPE_RESOURCES` fails the moment a
 * new type registers without a schema here, so this never silently strips a
 * real type's extension fields in production.
 */
export const baseItemUpdateSchema = z.object({ ...itemUpdateBaseFields })

export const testPlanUpdateSchema = z.object({
  ...itemUpdateBaseFields,
  scope: z.string().max(5000).nullable().optional(),
  environment: z.string().max(100).nullable().optional(),
  entryCriteria: z.string().max(5000).nullable().optional(),
  exitCriteria: z.string().max(5000).nullable().optional(),
})

export const testCaseUpdateSchema = z.object({
  ...itemUpdateBaseFields,
  testPlanId: z.string().uuid().nullable().optional(),
  testType: z
    .enum(['Unit', 'Integration', 'System', 'Acceptance'])
    .nullable()
    .optional(),
  preconditions: z.string().max(5000).nullable().optional(),
  steps: z.array(testStepSchema).nullable().optional(),
  executionStatus: z
    .enum(['NotRun', 'Passed', 'Failed', 'Blocked'])
    .nullable()
    .optional(),
  lastExecutedAt: z.coerce.date().nullable().optional(),
  lastExecutedBy: z.string().uuid().nullable().optional(),
  environment: z.string().max(100).nullable().optional(),
})

export const workInstructionUpdateSchema = z.object({
  ...itemUpdateBaseFields,
  description: z.string().max(10000).nullable().optional(),
  estimatedTime: z.number().int().min(0).nullable().optional(),
  difficulty: z.enum(['Easy', 'Medium', 'Hard']).nullable().optional(),
  safetyNotes: z.string().max(10000).nullable().optional(),
  requiredTools: z.string().max(5000).nullable().optional(),
})

export const issueUpdateSchema = z.object({
  ...itemUpdateBaseFields,
  description: z.string().max(10000).nullable().optional(),
  severity: z.enum(issueSeverities).nullable().optional(),
  priority: z.enum(issuePriorities).nullable().optional(),
  category: z.enum(issueCategories).nullable().optional(),
  reportedBy: z.string().uuid().nullable().optional(),
  reportedDate: z.coerce.date().nullable().optional(),
  assignedTo: z.string().uuid().nullable().optional(),
  resolution: z.string().max(10000).nullable().optional(),
  resolvedDate: z.coerce.date().nullable().optional(),
  rootCause: z.string().max(10000).nullable().optional(),
  // The program the issue is scoped on, and the only way to set one on a row
  // that has none. Creation derives it from the chosen designs, which leaves
  // every issue predating that derivation reachable by cross-program authority
  // alone — so this field is the repair path, not a convenience: without it a
  // row with no design and no links would be visible to an administrator and
  // still unfixable through any route. Writing it is a write *into* the
  // destination program and is membership-checked at the route, the rule
  // `PUT /api/v1/work-orders/:id` applies to a reassignment.
  programId: z.string().uuid().nullable().optional(),
  // Junction-table associations the type handler replaces wholesale.
  designIds: z.array(z.string().uuid()).optional(),
  affectedItemIds: z.array(z.string().uuid()).optional(),
})

export const toolUpdateSchema = z.object({
  ...itemUpdateBaseFields,
  toolType: z.string().max(50).nullable().optional(),
  toolSubtype: z.string().max(50).nullable().optional(),
  manufacturer: z.string().max(200).nullable().optional(),
  model: z.string().max(200).nullable().optional(),
  // Structured per-subtype capabilities; shape varies, validated on use.
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
})

export const softwareUpdateSchema = z.object({
  ...itemUpdateBaseFields,
  description: z.string().max(10000).nullable().optional(),
  softwareType: z
    .enum(['firmware', 'application', 'library', 'configuration', 'fpga'])
    .nullable()
    .optional(),
  // NOT NULL with a default, so never null on a read.
  sourceMode: z.enum(['internal', 'external']).optional(),
  version: z.string().max(50).nullable().optional(),
  targetHardware: z.string().max(200).nullable().optional(),
  toolchain: z.string().max(200).nullable().optional(),
  buildArtifactFileId: z.string().uuid().nullable().optional(),
  // manifestId / draftManifestId are deliberately absent: the source store
  // (checkout, draft, commit) is the only writer of those pointers.
})

/**
 * WorkOrder: the type-route's own schema plus the base-item fields. completedAt
 * is deliberately absent — completion is a flow, not a field edit.
 */
export const workOrderItemUpdateSchema = workOrderUpdateSchema.extend({
  ...itemUpdateBaseFields,
})

/**
 * PhysicalPart: mirrors the physical-parts route's update contract. Identity
 * (serial/lot/kind/part lineage) and the produce-flow pins (asBuiltItemId,
 * producingWorkOrderId) are deliberately absent.
 */
export const physicalPartItemUpdateSchema = z.object({
  ...itemUpdateBaseFields,
  manufacturerPartId: z.string().uuid().nullable().optional(),
  erpRef: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
})

const ITEM_UPDATE_SCHEMAS: Record<string, z.ZodType> = {
  Part: partUpdateSchema,
  Document: documentUpdateSchema,
  Requirement: requirementUpdateSchema,
  Task: taskUpdateSchema,
  ChangeOrder: changeOrderUpdateSchema,
  TestPlan: testPlanUpdateSchema,
  TestCase: testCaseUpdateSchema,
  WorkInstruction: workInstructionUpdateSchema,
  Issue: issueUpdateSchema,
  Tool: toolUpdateSchema,
  Software: softwareUpdateSchema,
  WorkOrder: workOrderItemUpdateSchema,
  PhysicalPart: physicalPartItemUpdateSchema,
}

/**
 * The update schema `PUT /items/:id` runs for a given item type.
 *
 * Always returns a schema: an unknown type gets the base-item schema, which
 * accepts the fields every item carries and strips the rest — and the
 * parameterized test over every registered type guarantees "unknown" cannot
 * happen for a type that actually exists.
 */
export function itemUpdateSchemaFor(
  itemType: string,
): z.ZodType<Record<string, unknown>> {
  return (ITEM_UPDATE_SCHEMAS[itemType] ?? baseItemUpdateSchema) as z.ZodType<
    Record<string, unknown>
  >
}

// =============================================================================
// Program Schemas (re-exported from ProgramService for API consistency)
// =============================================================================

export const programCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  code: z
    .string()
    .min(1, 'Code is required')
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  description: z.string().optional(),
  contractNumber: z.string().max(100).optional(),
  customer: z.string().max(200).optional(),
  startDate: z.coerce.date().optional(),
  targetEndDate: z.coerce.date().optional(),
  status: z.enum(['Active', 'On Hold', 'Completed', 'Cancelled']).optional(),
})

export const programUpdateSchema = programCreateSchema.partial()

export type ProgramCreate = z.infer<typeof programCreateSchema>
export type ProgramUpdate = z.infer<typeof programUpdateSchema>

// =============================================================================
// Design Schemas (re-exported from DesignService for API consistency)
// =============================================================================

export const designCreateSchema = z.object({
  programId: z.string().uuid().optional().nullable(),
  name: z.string().min(1, 'Name is required').max(200),
  code: z
    .string()
    .min(1, 'Code is required')
    .max(50)
    .regex(/^[A-Z0-9-]+$/, 'Code must be uppercase alphanumeric with hyphens'),
  description: z.string().optional(),
  designType: z
    .enum(['Engineering', 'Library', 'Family'])
    .optional()
    .default('Engineering'),
  parentDesignId: z.string().uuid().optional().nullable(),
  plannedQuantity: z.number().int().positive().optional(),
})

export const designUpdateSchema = designCreateSchema
  .partial()
  .omit({ designType: true })

export type DesignCreate = z.infer<typeof designCreateSchema>
export type DesignUpdate = z.infer<typeof designUpdateSchema>

// =============================================================================
// Tag Schemas
// =============================================================================

export const tagCreateSchema = z.object({
  name: z.string().min(1, 'Tag name is required').max(100),
  description: z.string().optional(),
  tagType: z
    .enum(['baseline', 'release', 'milestone', 'eco-release'])
    .optional()
    .default('baseline'),
  commitId: z.string().uuid('Commit is required'),
})

export const tagUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().optional(),
})

export type TagCreate = z.infer<typeof tagCreateSchema>
export type TagUpdate = z.infer<typeof tagUpdateSchema>

// =============================================================================
// Program Member Schemas
// =============================================================================

export const programMemberRoleSchema = z.enum([
  'admin',
  'lead',
  'engineer',
  'viewer',
])

export const programMemberCreateSchema = z.object({
  userId: z.string().uuid('User is required'),
  role: programMemberRoleSchema.default('viewer'),
  canCreateEco: z.boolean().optional().default(false),
  canApproveEco: z.boolean().optional().default(false),
  canManageDesigns: z.boolean().optional().default(false),
})

export const programMemberUpdateSchema = z.object({
  role: programMemberRoleSchema.optional(),
  canCreateEco: z.boolean().optional(),
  canApproveEco: z.boolean().optional(),
  canManageDesigns: z.boolean().optional(),
})

export type ProgramMemberCreate = z.infer<typeof programMemberCreateSchema>
export type ProgramMemberUpdate = z.infer<typeof programMemberUpdateSchema>

// =============================================================================
// Batch Operation Schemas
// =============================================================================

/**
 * Schema for batch create operations.
 */
export const batchCreateItemSchema = z.object({
  itemType: z.enum(['Part', 'Document', 'Requirement', 'Task', 'ChangeOrder']),
  data: z.record(z.string(), z.unknown()),
})

export const batchCreateRequestSchema = z.object({
  items: z.array(batchCreateItemSchema).min(1, 'At least one item is required'),
  bypassBranchProtection: z.boolean().optional().default(false),
})

/**
 * Schema for batch update operations.
 */
export const batchUpdateItemSchema = z.object({
  id: z.string().uuid(),
  data: z.record(z.string(), z.unknown()),
})

export const batchUpdateRequestSchema = z.object({
  items: z.array(batchUpdateItemSchema).min(1, 'At least one item is required'),
  branchId: z.string().uuid().optional(),
  commitMessage: z.string().max(500).optional(),
})

/**
 * Schema for batch delete operations.
 */
export const batchDeleteRequestSchema = z.object({
  itemIds: z
    .array(z.string().uuid())
    .min(1, 'At least one item ID is required'),
  branchId: z.string().uuid('Branch is required for deletion'),
  commitMessage: z.string().max(500).optional(),
})

/**
 * Schema for batch checkout operations (CAD workflow support).
 */
export const batchCheckoutRequestSchema = z.object({
  itemIds: z
    .array(z.string().uuid())
    .min(1, 'At least one item ID is required'),
  branchId: z.string().uuid('Branch is required for checkout'),
})

/**
 * Schema for batch checkin operations (CAD workflow support).
 */
export const batchCheckinRequestSchema = z.object({
  itemIds: z
    .array(z.string().uuid())
    .min(1, 'At least one item ID is required'),
  branchId: z.string().uuid('Branch is required for checkin'),
})

/**
 * Schema for batch file checkout operations (CAD plugin workflow).
 */
export const batchFileCheckoutRequestSchema = z.object({
  // The cap was a hand-rolled check in the handler; here it names the field.
  fileIds: z
    .array(z.string().uuid())
    .min(1, 'At least one file ID is required')
    .max(100, 'Batch size limited to 100 files'),
})

/**
 * Schema for batch file checkin operations (CAD plugin workflow).
 * Note: New versions must be uploaded individually via the single file checkin endpoint.
 */
export const batchFileCheckinRequestSchema = z.object({
  // The cap was a hand-rolled check in the handler; here it names the field.
  fileIds: z
    .array(z.string().uuid())
    .min(1, 'At least one file ID is required')
    .max(100, 'Batch size limited to 100 files'),
})

export type BatchCreateItem = z.infer<typeof batchCreateItemSchema>
export type BatchCreateRequest = z.infer<typeof batchCreateRequestSchema>
export type BatchUpdateItem = z.infer<typeof batchUpdateItemSchema>
export type BatchUpdateRequest = z.infer<typeof batchUpdateRequestSchema>
export type BatchDeleteRequest = z.infer<typeof batchDeleteRequestSchema>
export type BatchCheckoutRequest = z.infer<typeof batchCheckoutRequestSchema>
export type BatchCheckinRequest = z.infer<typeof batchCheckinRequestSchema>
export type BatchFileCheckoutRequest = z.infer<
  typeof batchFileCheckoutRequestSchema
>
export type BatchFileCheckinRequest = z.infer<
  typeof batchFileCheckinRequestSchema
>

// =============================================================================
// Common Query Parameter Schemas
// =============================================================================

/**
 * Standard pagination parameters.
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
})

/**
 * Version context parameters for querying items at specific versions.
 */
export const versionContextSchema = z.object({
  designId: z.string().uuid().optional(),
  branch: z.string().optional(),
  commitId: z.string().uuid().optional(),
  tag: z.string().optional(),
})

/**
 * Combined query parameters for item list endpoints.
 * Merges pagination + version context + filtering.
 */
export const itemListSchema = paginationSchema
  .merge(versionContextSchema)
  .extend({
    itemType: z.string().optional(),
    state: z.string().optional(),
    search: z.string().optional(),
    includeDeleted: z
      .string()
      .optional()
      .default('false')
      .transform((v) => v === 'true'),
  })

export type Pagination = z.infer<typeof paginationSchema>
export type VersionContext = z.infer<typeof versionContextSchema>
export type ItemListQuery = z.infer<typeof itemListSchema>

// =============================================================================
// Workflow Definition Schemas
// =============================================================================

/**
 * A workflow definition is the most deeply nested body the API accepts, and
 * the lifecycle editor is its only real client. These schemas mirror the
 * interfaces in `lib/workflows/types.ts` and `lib/types/lifecycle.ts` field
 * for field, with these notes:
 *
 * - Guards and actions are discriminated unions on `type`, so a `field_value`
 *   guard cannot carry a `user_role` config. `GuardEvaluator` narrows the same
 *   way when it runs them.
 * - Editor-only presentation fields (`position`, `labelPosition`, `color`)
 *   are accepted because the editor round-trips them; they are persisted with
 *   the definition and mean nothing to the engine.
 */

export const revisionSchemeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('alpha'), uppercase: z.boolean().optional() }),
  z.object({ type: z.literal('numeric') }),
  z.object({ type: z.literal('prefixed-numeric'), prefix: z.string().max(20) }),
  z.object({ type: z.literal('none') }),
])

const pointSchema = z.object({ x: z.number(), y: z.number() })

export const workflowStateSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  color: z.string().max(50).optional(),
  description: z.string().max(2000).optional(),
  isInitial: z.boolean().optional(),
  isFinal: z.boolean().optional(),
  // The release-vs-cancel decision is made from this alone, never from the
  // state's name — so an unknown value here is a 400, not a default.
  finalKind: z.enum(['release', 'cancel', 'complete']).optional(),
  position: pointSchema.optional(),
  phaseId: z.string().max(100).optional(),
  /** Instance-level states carry reviewer instructions; definitions ignore it. */
  instructions: z.string().max(5000).optional(),
})

/** `config` is a union keyed by `type`; both arms are spelled out. */
const transitionGuardSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    type: z.literal('field_value'),
    config: z.object({
      fieldName: z.string().min(1).max(100),
      operator: z.enum([
        'equals',
        'not_equals',
        'contains',
        'is_empty',
        'is_not_empty',
        'greater_than',
        'less_than',
        'greater_or_equal',
        'less_or_equal',
      ]),
      value: z
        .union([z.string().max(1000), z.number(), z.boolean()])
        .optional(),
    }),
    errorMessage: z.string().max(1000).optional(),
  }),
  z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    type: z.literal('user_role'),
    config: z.object({
      requiredRoles: z.array(z.string().max(200)).max(100),
      requireAll: z.boolean().optional(),
    }),
    errorMessage: z.string().max(1000).optional(),
  }),
])

const transitionActionSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    type: z.literal('send_notification'),
    executeOn: z.enum(['before', 'after']),
    config: z.object({
      recipients: z
        .array(
          z.object({
            type: z.enum(['user', 'role']),
            id: z.string().max(200),
          }),
        )
        .max(100),
      // The only template there is; a typo used to reach the notifier.
      templateId: z.literal('workflow_transition'),
    }),
  }),
  z.object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    type: z.literal('update_field'),
    executeOn: z.enum(['before', 'after']),
    config: z.object({
      fieldName: z.string().min(1).max(100),
      value: z.union([z.string().max(1000), z.number(), z.boolean()]),
    }),
  }),
])

export const workflowTransitionSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  fromStateId: z.string().min(1).max(100),
  toStateId: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  guards: z.array(transitionGuardSchema).max(50).optional(),
  actions: z.array(transitionActionSchema).max(50).optional(),
  labelPosition: pointSchema.optional(),
  approvalRequirement: z
    .object({ requiredCount: z.number().int().min(0).max(100) })
    .optional(),
})

const stateChangeActionMappingSchema = z.object({
  fromState: z.string().min(1).max(100),
  toState: z.string().min(1).max(100),
  assignsRevision: z.boolean(),
})

export const changeActionMappingsSchema = z.object({
  release: stateChangeActionMappingSchema.optional(),
  revise: z
    .object({
      fromState: z.string().min(1).max(100),
      newVersionState: z.string().min(1).max(100),
      oldVersionState: z.string().min(1).max(100),
      assignsRevision: z.literal(true),
    })
    .optional(),
  obsolete: stateChangeActionMappingSchema.optional(),
  promote: stateChangeActionMappingSchema
    .extend({ resetRevision: z.boolean().optional() })
    .optional(),
})

export const lifecyclePhaseSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  revisionScheme: revisionSchemeSchema.optional(),
  resetRevisionOnEntry: z.boolean().optional(),
  color: z.string().max(50).optional(),
  order: z.number().int().min(0).max(1000),
})

/** Fields shared by the create and update bodies. */
const workflowDefinitionFields = {
  description: z.string().max(5000).optional(),
  applicableItemTypes: z.array(z.string().max(100)).max(100).optional(),
  transitions: z.array(workflowTransitionSchema).max(500).optional(),
  changeActionMappings: changeActionMappingsSchema.optional(),
  isActive: z.boolean().optional(),
  lifecycleType: z.enum(['Free', 'Driven', 'Driving']).optional(),
  drivers: z.array(z.string().max(100)).max(100).optional(),
  revisionScheme: revisionSchemeSchema.optional(),
  phases: z.array(lifecyclePhaseSchema).max(100).optional(),
}

export const workflowDefinitionCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200),
  // Legacy input resolved through normalize.ts when lifecycleType is absent.
  workflowType: z.enum(['strict', 'flexible']).optional(),
  states: z.array(workflowStateSchema).max(500).optional(),
  ...workflowDefinitionFields,
})

export const workflowDefinitionUpdateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  states: z.array(workflowStateSchema).max(500).optional(),
  ...workflowDefinitionFields,
})

/**
 * One approver on a workflow state — a user or a role, by id.
 *
 * `isRequired` defaults to true here rather than in each route: the column
 * defaults to true, the add-one route defaulted it in the handler, and the
 * replace-all route passed `undefined` through and got the column default by
 * accident. One default, in one place, and the two routes now agree.
 */
export const stateApproverInputSchema = z.object({
  type: z.enum(['user', 'role']),
  id: z.string().uuid(),
  isRequired: z.boolean().default(true),
})

export const stateApproversReplaceSchema = z.object({
  approvers: z.array(stateApproverInputSchema).max(100),
})

export const stateApproverPatchSchema = z.object({
  isRequired: z.boolean(),
})

// =============================================================================
// AI Settings Schemas
// =============================================================================

/**
 * The provider list is shared, deliberately.
 *
 * `admin.ts` and `ai.ts` both write the `ai_settings` row, and their two
 * hand-rolled validations had drifted: admin accepted openai / anthropic /
 * gemini / ollama, while `POST /api/v1/ai/settings` rejected anything but
 * openai and anthropic — so a Gemini configuration saved from one surface was
 * unsavable from the other. One enum now, in one place.
 */
export const aiProviderTypeSchema = z.enum([
  'openai',
  'anthropic',
  'gemini',
  'ollama',
])

export const aiProviderConfigSchema = z.object({
  provider: aiProviderTypeSchema,
  apiKey: z.string().max(2000).optional(),
  // Present but possibly empty — an empty model falls back at call time.
  model: z.string().max(200),
  baseURL: z.string().max(2000).optional(),
  // Monthly token ceiling for this row's scope (program row: that program;
  // global row: the whole instance). Enforced at 429 by loadProviderConfig;
  // unset means unlimited.
  monthlyTokenBudget: z.number().int().positive().optional(),
})

/** Body of the admin and per-program AI settings writes. */
export const aiSettingsUpdateSchema = z.object({
  enabled: z.boolean(),
  provider: aiProviderTypeSchema,
  config: aiProviderConfigSchema,
})
