/**
 * API Module
 *
 * Centralized exports for API utilities including:
 * - Handler wrapper
 * - Response builders
 * - Lock status helpers
 * - Request/response schemas
 *
 * @example
 * ```typescript
 * import {
 *   apiHandler,
 *   createSingleResponse,
 *   createCollectionResponse,
 *   partCreateSchema,
 *   partUpdateSchema,
 * } from '@/lib/api'
 *
 * // In an API route handler
 * const validated = partCreateSchema.parse(body)
 * return createSingleResponse(part, { resourceName: 'part' })
 * ```
 */

// Handler wrapper, query parsing, and response helpers
export {
  apiHandler,
  parseQuery,
  created,
  jsonResponse,
  type HandlerOptions,
  type HandlerContext,
  type HandlerFn,
} from './handler'

// Response builders
export {
  createSingleResponse,
  createCollectionResponse,
  buildErrorResponse,
  createSuccessResponse,
  createCreatedResponse,
  createNoContentResponse,
  type PaginationMeta,
} from './response'

// Lock status utilities
export {
  lockHolderSchema,
  lockScopeSchema,
  lockTypeSchema,
  lockStatusSchema,
  checkoutStatusSchema,
  createUnlockedStatus,
  createLockedStatus,
  createNotCheckedOutStatus,
  createCheckedOutStatus,
  checkoutToLockStatus,
  calculateLockDuration,
  type LockHolder,
  type LockScope,
  type LockType,
  type LockStatus,
  type CheckoutStatusResponse,
} from './lock-status'

// Request/response schemas
export {
  // User schemas
  userCreateSchema,
  userUpdateSchema,
  type UserCreate,
  type UserUpdate,

  // Part schemas
  partCreateSchema,
  partUpdateSchema,
  type PartCreate,
  type PartUpdate,

  // Document schemas
  documentCreateSchema,
  documentUpdateSchema,
  type DocumentCreate,
  type DocumentUpdate,

  // Requirement schemas
  requirementCreateSchema,
  requirementUpdateSchema,
  requirementPrioritySchema,
  verificationMethodSchema,
  type RequirementCreate,
  type RequirementUpdate,

  // Task schemas
  taskCreateSchema,
  taskUpdateSchema,
  taskPrioritySchema,
  type TaskCreate,
  type TaskUpdate,

  // Change Order schemas
  changeOrderCreateSchema,
  changeOrderUpdateSchema,
  changeOrderTypeSchema,
  changeOrderPrioritySchema,
  riskLevelSchema,
  type ChangeOrderCreate,
  type ChangeOrderUpdate,

  // Program schemas
  programCreateSchema,
  programUpdateSchema,
  type ProgramCreate,
  type ProgramUpdate,

  // Design schemas
  designCreateSchema,
  designUpdateSchema,
  type DesignCreate,
  type DesignUpdate,

  // Tag schemas
  tagCreateSchema,
  tagUpdateSchema,
  type TagCreate,
  type TagUpdate,

  // Program Member schemas
  programMemberCreateSchema,
  programMemberUpdateSchema,
  programMemberRoleSchema,
  type ProgramMemberCreate,
  type ProgramMemberUpdate,

  // Batch operation schemas
  batchCreateItemSchema,
  batchCreateRequestSchema,
  batchUpdateItemSchema,
  batchUpdateRequestSchema,
  batchDeleteRequestSchema,
  batchCheckoutRequestSchema,
  batchCheckinRequestSchema,
  type BatchCreateItem,
  type BatchCreateRequest,
  type BatchUpdateItem,
  type BatchUpdateRequest,
  type BatchDeleteRequest,
  type BatchCheckoutRequest,
  type BatchCheckinRequest,

  // Query parameter schemas
  paginationSchema,
  versionContextSchema,
  itemListSchema,
  type Pagination,
  type VersionContext,
  type ItemListQuery,
} from './schemas'

// Client utilities (for frontend use)
export {
  ApiError,
  apiFetch,
  apiGet,
  apiPost,
  apiPut,
  apiPatch,
  apiDelete,
} from './client'
