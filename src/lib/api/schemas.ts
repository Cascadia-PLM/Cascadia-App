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

// =============================================================================
// User Schemas
// =============================================================================

/**
 * Schema for creating a new user.
 */
export const userCreateSchema = z
  .object({
    email: z.string().email('Valid email is required'),
    name: z.string().min(1, 'Name is required').max(200),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    passwordConfirm: z.string().optional(),
  })
  .refine(
    (data) => !data.passwordConfirm || data.password === data.passwordConfirm,
    {
      message: 'Passwords do not match',
      path: ['passwordConfirm'],
    },
  )

/**
 * Schema for updating a user.
 * Password is optional - only update if provided.
 */
export const userUpdateSchema = z
  .object({
    email: z.string().email('Valid email is required').optional(),
    name: z.string().min(1).max(200).optional(),
    password: z
      .string()
      .min(8, 'Password must be at least 8 characters')
      .optional(),
    passwordConfirm: z.string().optional(),
  })
  .refine(
    (data) => !data.passwordConfirm || data.password === data.passwordConfirm,
    {
      message: 'Passwords do not match',
      path: ['passwordConfirm'],
    },
  )

export type UserCreate = z.infer<typeof userCreateSchema>
export type UserUpdate = z.infer<typeof userUpdateSchema>

// =============================================================================
// Part Schemas
// =============================================================================

/**
 * Schema for creating a new part.
 */
export const partCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  revision: z.string().min(1, 'Revision is required').max(10),
  name: z.string().max(500).optional(),
  designId: z.string().uuid('Design is required'),
  description: z.string().max(5000).optional(),
  partType: z
    .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
    .optional(),
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
 * All fields optional for PATCH-style updates.
 */
export const partUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  partType: z
    .enum(['Manufacture', 'Purchase', 'Software', 'Phantom'])
    .optional(),
  material: z.string().max(100).optional(),
  weight: z.string().optional(),
  weightUnit: z.string().max(10).optional(),
  cost: z.string().optional(),
  costCurrency: z.string().length(3).optional(),
  leadTimeDays: z.number().int().min(0).optional(),
  state: z.string().max(50).optional(),
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
  revision: z.string().min(1, 'Revision is required').max(10),
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
])

/**
 * Schema for creating a new requirement.
 */
export const requirementCreateSchema = z.object({
  itemNumber: z.string().min(1, 'Item number is required').max(100),
  revision: z.string().min(1, 'Revision is required').max(10),
  name: z.string().max(500).optional(),
  designId: z.string().uuid('Design is required'),
  requirementType: z.string().max(50).optional(),
  description: z.string().max(10000).optional(),
  priority: requirementPrioritySchema.optional(),
  verificationMethod: verificationMethodSchema.optional(),
  acceptanceCriteria: z.string().max(10000).optional(),
  rationale: z.string().max(5000).optional(),
  branchId: z.string().uuid().optional(),
})

/**
 * Schema for updating a requirement.
 */
export const requirementUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  requirementType: z.string().max(50).optional(),
  description: z.string().max(10000).optional(),
  priority: requirementPrioritySchema.optional(),
  verificationMethod: verificationMethodSchema.optional(),
  acceptanceCriteria: z.string().max(10000).optional(),
  rationale: z.string().max(5000).optional(),
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
  revision: z.string().min(1, 'Revision is required').max(10),
  name: z.string().max(500).optional(),
  designId: z.string().uuid().optional(), // Optional for tasks
  taskType: z.string().max(50).optional(),
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
  taskType: z.string().max(50).optional(),
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
  revision: z.string().min(1, 'Revision is required').max(10),
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
  canManageProducts: z.boolean().optional().default(false),
})

export const programMemberUpdateSchema = z.object({
  role: programMemberRoleSchema.optional(),
  canCreateEco: z.boolean().optional(),
  canApproveEco: z.boolean().optional(),
  canManageProducts: z.boolean().optional(),
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
  fileIds: z
    .array(z.string().uuid())
    .min(1, 'At least one file ID is required'),
})

/**
 * Schema for batch file checkin operations (CAD plugin workflow).
 * Note: New versions must be uploaded individually via the single file checkin endpoint.
 */
export const batchFileCheckinRequestSchema = z.object({
  fileIds: z
    .array(z.string().uuid())
    .min(1, 'At least one file ID is required'),
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
