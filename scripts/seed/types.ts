/**
 * Types for API-based seed script
 */

// API Response wrapper
export interface ApiResponse<T> {
  data: T
}

// Authentication
export interface LoginResponse {
  success: boolean
  user: {
    id: string
    email: string
    name: string
  }
}

// Users
export interface User {
  id: string
  email: string
  name: string
  active: boolean
}

export interface CreateUserInput {
  email: string
  name: string
  password: string
  active?: boolean
}

// Roles
export interface Role {
  id: string
  name: string
  description?: string
}

// Programs
export interface Program {
  id: string
  name: string
  code: string
  description?: string
  status: string
}

export interface CreateProgramInput {
  name: string
  code: string
  description?: string
  status?: string
  attributes?: Record<string, unknown>
}

export interface ProgramMember {
  id: string
  userId: string
  programId: string
  role: string
}

export interface AddProgramMemberInput {
  userId: string
  role: 'admin' | 'lead' | 'member'
  permissions?: {
    canCreateEco?: boolean
    canApproveEco?: boolean
    canManageProducts?: boolean
  }
}

// Designs
export interface Design {
  id: string
  name: string
  code: string
  programId: string | null
  designType: string
  defaultBranchId?: string
}

export interface CreateDesignInput {
  programId?: string // Optional for library designs
  name: string
  code: string
  description?: string
  designType?: 'Engineering' | 'Library' | 'Family'
  parentDesignId?: string
  attributes?: Record<string, unknown>
}

// Branches
export interface Branch {
  id: string
  designId: string
  name: string
  branchType: string
  changeOrderItemId?: string
  headCommitId?: string
}

// Tags
export interface Tag {
  id: string
  designId: string
  name: string
  tagType: string
  commitId: string
}

export interface CreateTagInput {
  name: string
  description?: string
  tagType?: 'baseline' | 'milestone' | 'release'
}

// Items
export interface Item {
  id: string
  masterId: string
  itemNumber: string
  revision: string
  itemType: string
  name: string
  state: string
  designId?: string
}

export interface Part extends Item {
  description?: string
  partType?: string
  material?: string
  isCurrent?: boolean
  // Usage/Definition pattern (SysML v2 style)
  usageOf?: string // If set, this is a usage referencing a definition
  usageCount?: number // Number of designs using this definition (global view only)
}

export interface CreatePartInput {
  itemNumber: string
  name: string
  description?: string
  partType?: string
  material?: string
  designId?: string
  branchId?: string
  state?: string
  revision?: string
}

// Batch operations
export interface BatchCreateItemInput {
  itemType: 'Part' | 'Document' | 'Requirement' | 'Task'
  data: Record<string, unknown>
}

export interface BatchCreateResult {
  created: Array<Item>
  errors: Array<{ itemNumber: string; error: string; details?: string }>
}

// Relationships
export interface RelationshipInput {
  sourceId: string
  targetId: string
  relationshipType: 'BOM' | 'Reference' | 'Dependency' | 'CAD Doc'
  quantity?: number
  findNumber?: number
  referenceDesignator?: string
}

export interface BatchRelationshipResult {
  created: number
  skipped: number
  errors: Array<{ index: number; error: string }>
}

// Change Orders
export interface ChangeOrder extends Item {
  changeType: string
  priority: string
  reasonForChange?: string
  title?: string
}

export interface CreateChangeOrderInput {
  itemNumber?: string
  name: string
  title?: string
  revision?: string
  designId?: string
  changeType?: 'ECO' | 'ECN' | 'Deviation' | 'MCO' | 'XCO'
  priority?: 'low' | 'medium' | 'high' | 'critical'
  reasonForChange?: string
  description?: string
}

// Affected Items
export interface AffectedItem {
  id: string
  changeOrderId: string
  affectedItemId: string
  affectedItemMasterId?: string
  changeAction: string
  currentState?: string
  currentRevision?: string
  targetState?: string
  targetRevision?: string
  workingCopyId?: string
}

export interface AffectedItemInput {
  affectedItemId: string
  affectedItemMasterId?: string
  changeAction: 'release' | 'revise' | 'obsolete' | 'add' | 'remove'
  currentState?: string
  currentRevision?: string
  targetState?: string
  targetRevision?: string
  changeDescription?: string
}

// ECO Actions
export interface EcoActionResult {
  success: boolean
  message: string
  details?: Record<string, unknown>
}

// Checkout
export interface CheckoutResult {
  success: boolean
  branchItemId?: string
  workingCopyId?: string
  branchId?: string
}

// Workflows
export interface WorkflowDefinition {
  id: string
  name: string
  definitionType: string
  states: Array<unknown>
  transitions: Array<unknown>
}

// Conflict Detection
export interface FieldConflict {
  fieldName: string
  fieldPath?: string
  baseValue: unknown
  ourValue: unknown
  theirValue: unknown
}

export interface ItemConflict {
  itemMasterId: string
  itemNumber: string
  itemName: string | null
  conflictType:
    | 'checkout'
    | 'concurrent_modification'
    | 'field_conflict'
    | 'cross_eco'
    | 'no_changes'
  severity: 'error' | 'warning' | 'info'
  ourItemId: string
  ourRevision: string
  ourBranchId: string
  ourBranchName: string
  theirItemId?: string
  theirRevision?: string
  theirEcoId?: string
  theirEcoNumber?: string
  fieldConflicts: Array<FieldConflict>
  suggestedResolution?: 'rebase' | 'merge' | 'manual' | 'coordinate'
}

export interface ConflictDetectionResult {
  hasConflicts: boolean
  hasBlockingConflicts: boolean
  conflicts: Array<ItemConflict>
  checkedAt: string
  summary: {
    total: number
    errors: number
    warnings: number
    info: number
  }
}

// Workflow Structure (for flexible/XCO workflows)
export interface WorkflowState {
  id: string
  name: string
  color?: string
  description?: string
  isInitial?: boolean
  isFinal?: boolean
  position?: { x: number; y: number }
}

export interface WorkflowTransition {
  id: string
  name: string
  fromStateId: string
  toStateId: string
  description?: string
  approvalRequirement?: {
    requiredCount: number
  }
}

export interface WorkflowStructure {
  states: Array<WorkflowState>
  transitions: Array<WorkflowTransition>
  currentState: string
  canEdit: boolean
}

export interface WorkflowTransitionResult {
  success: boolean
  newState: string
  message?: string
}

// Component Catalog
//
// The seed input is intentionally permissive — JSON files in `test-data/`
// carry mixed-type spec values (numbers, booleans, nested objects) and
// `null`-valued electrical fields. The DB columns are jsonb, so anything
// JSON-serializable round-trips; the runtime API uses the same loose shape
// (z.record(z.string(), z.unknown()) for specs).
export interface CatalogEntryDef {
  name: string
  description: string
  categorySlug: string
  entryType: 'component' | 'raw_stock'
  dimensions?: Record<string, number | string | null> | null
  mountingFeatures?: Array<{
    type: string
    specs: Record<string, unknown>
  }> | null
  electrical?: Record<string, string | null> | null
  specs?: Record<string, unknown>
  stockSizes?: Array<{
    label: string
    dimensions: Record<string, number>
    supplierPartNumber?: string
    approximatePrice?: number
  }> | null
  suppliers?: Array<{
    name: string
    partNumber?: string
    approximatePrice: number
    url?: string
    lastVerified?: string
  }>
  designNotes?: string | null
  tags?: Array<string>
}

// MBOM
export interface MbomCreationResult {
  design: Design
  mainBranch: Branch
  initialCommit: { id: string }
  itemsCopied: number
  relationshipsCopied: number
  sourceLinks: number
}
