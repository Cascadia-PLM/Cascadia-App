/**
 * Core types for the workflow/lifecycle system
 *
 * This system supports two types of definitions:
 * - Lifecycles: State definitions for Parts/Documents with changeActionMappings (no manual transitions)
 * - Workflows: Active approval processes for Change Orders (manual transitions, guards, actions)
 *
 * Key principle: All item state changes go through ECOs.
 * Lifecycles define HOW change actions affect item states.
 * Workflows define the approval process for ECOs.
 */

import type {
  ChangeAction,
  ChangeActionMappings,
  LifecyclePhaseConfig,
  RevisionScheme,
} from '@/lib/types/lifecycle'

// ============================================
// Definition Types
// ============================================

export type DefinitionType = 'lifecycle' | 'workflow'
export type WorkflowType = 'strict' | 'flexible'

/**
 * Unified lifecycle type that determines how a lifecycle behaves:
 * - Free: Self-controlled with manual transitions (Programs, Projects, Designs)
 * - Driven: Controlled by ECOs, declares valid states only (Parts, Documents, Requirements)
 * - Driving: Controls Driven lifecycles via TransitionDrivenItem actions (Change Orders)
 */
export type LifecycleType = 'Free' | 'Driven' | 'Driving'

/**
 * Complete workflow/lifecycle definition stored in database
 *
 * Unified Lifecycle Model:
 * - Free lifecycles: Self-controlled with manual transitions (Programs, Projects, Designs)
 * - Driven lifecycles: ECO-controlled, declares states only (Parts, Documents, Requirements)
 * - Driving lifecycles: Controls Driven lifecycles via TransitionDrivenItem actions (Change Orders)
 *
 * @deprecated definitionType and changeActionMappings are deprecated.
 * Use lifecycleType instead: Free, Driven, or Driving.
 */
export interface WorkflowDefinition {
  id: string
  name: string
  version: number
  /** @deprecated Use lifecycleType instead */
  definitionType: DefinitionType
  workflowType: WorkflowType
  description?: string
  applicableItemTypes?: Array<string>
  states: Array<WorkflowState>

  /** Manual transitions - used by Free and Driving lifecycles */
  transitions?: Array<WorkflowTransition>

  /**
   * @deprecated Use TransitionDrivenItem actions on Driving lifecycle transitions instead.
   * Change action mappings - legacy method for ECO-driven state changes
   */
  changeActionMappings?: ChangeActionMappings

  isActive: boolean
  createdAt?: Date

  // ============================================
  // Unified Lifecycle Model Fields
  // ============================================

  /** Lifecycle type: Free, Driven, or Driving */
  lifecycleType?: LifecycleType

  /**
   * For Driven lifecycles: IDs of Driving lifecycles that can control this lifecycle.
   * For example, a Parts lifecycle might allow both "Standard ECO" and "Express ECO" drivers.
   */
  drivers?: Array<string>

  // ============================================
  // Revision & Phase Configuration
  // ============================================

  /** Default revision scheme for this lifecycle (alpha if not specified) */
  revisionScheme?: RevisionScheme

  /** Lifecycle phases that group states into logical stages */
  phases?: Array<LifecyclePhaseConfig>
}

/**
 * State in a workflow/lifecycle
 */
export interface WorkflowState {
  id: string
  name: string
  color?: string
  description?: string
  isInitial?: boolean
  isFinal?: boolean
  position?: { x: number; y: number }
  /** ID of the lifecycle phase this state belongs to */
  phaseId?: string
}

/**
 * Transition between states
 */
export interface WorkflowTransition {
  id: string
  name: string
  fromStateId: string
  toStateId: string
  description?: string
  guards?: Array<TransitionGuard>
  actions?: Array<TransitionAction>
  allowedRoles?: Array<string>
  approvalRequirement?: ApprovalRequirement
  lifecycleEffects?: Array<LifecycleEffect> // ECO-to-Item lifecycle coordination
  labelPosition?: { x: number; y: number } // Custom label position (acts as path waypoint)
}

// ============================================
// Instance-Level Workflow Types (for Flexible Workflows)
// ============================================

/**
 * Instance-level workflow state (simplified version for ad-hoc workflows)
 * Extends WorkflowState with assignees and instructions
 */
export interface InstanceWorkflowState extends WorkflowState {
  /** User IDs who need to approve/action at this state */
  assignees?: Array<string>
  /** Instructions for the assignees */
  instructions?: string
}

/**
 * Instance-level transition (simplified - no guards, only approvals)
 * Used for flexible workflows where users can define custom routing
 */
export interface InstanceWorkflowTransition {
  id: string
  name: string
  fromStateId: string
  toStateId: string
  description?: string
  /** Approval requirements (supported for ad-hoc transitions) */
  approvalRequirement?: ApprovalRequirement
  /** Custom label position for React Flow rendering */
  labelPosition?: { x: number; y: number }
  // Note: guards and actions are NOT supported for instance-level transitions
  // This keeps the ad-hoc workflow simple and user-manageable
}

/**
 * Effective workflow structure (resolved from definition or instance)
 * Used by WorkflowService to get the current workflow structure for an instance
 */
export interface EffectiveWorkflowStructure {
  states: Array<WorkflowState>
  transitions: Array<WorkflowTransition | InstanceWorkflowTransition>
  /** True if using instance-level overrides, false if using definition */
  isInstanceLevel: boolean
  /** True if the workflow can be edited (flexible + not completed) */
  canEdit: boolean
  /** The underlying workflow definition (for lifecycle effects, etc.) */
  definition: WorkflowDefinition
}

// ============================================
// Guard Types
// ============================================

export type GuardType = 'field_value' | 'user_role' | 'approval_count'
export type FieldOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'is_empty'
  | 'is_not_empty'
  | 'greater_than'
  | 'less_than'
  | 'greater_or_equal'
  | 'less_or_equal'

/**
 * Guard that must pass before a transition can occur
 */
export interface TransitionGuard {
  id: string
  name: string
  type: GuardType
  config: FieldValueConfig | UserRoleConfig | ApprovalCountConfig
  errorMessage?: string
}

export interface FieldValueConfig {
  fieldName: string
  operator: FieldOperator
  value?: string | number | boolean
}

export interface UserRoleConfig {
  requiredRoles: Array<string>
  requireAll?: boolean
}

export interface ApprovalCountConfig {
  requiredCount: number
  requiredRoles?: Array<string>
}

// ============================================
// Action Types
// ============================================

export type ActionType =
  | 'send_notification'
  | 'update_field'
  | 'create_task'
  | 'transition_driven_item'

export type ActionExecuteOn = 'before' | 'after'

/**
 * Action that executes during a transition
 */
export interface TransitionAction {
  id: string
  name: string
  type: ActionType
  executeOn: ActionExecuteOn
  config:
    | SendNotificationConfig
    | UpdateFieldConfig
    | CreateTaskConfig
    | TransitionDrivenItemConfig
}

export type NotificationRecipientType = 'user' | 'role'

export interface NotificationRecipient {
  type: NotificationRecipientType
  id: string // userId or roleId
}

export interface SendNotificationConfig {
  /** Recipients to notify (users or roles) */
  recipients: Array<NotificationRecipient>
  /** Template ID - currently only 'workflow_transition' is supported */
  templateId: 'workflow_transition'
}

export interface UpdateFieldConfig {
  fieldName: string
  value: string | number | boolean
}

export interface CreateTaskConfig {
  taskTemplate: string
  assignTo: string
}

/**
 * Configuration for TransitionDrivenItem action.
 * Used by Driving lifecycles (ECOs) to transition affected items
 * on their Driven lifecycles (Parts, Documents, etc.)
 *
 * Each action targets a specific Driven lifecycle and defines the
 * from/to state transition. A transition can have multiple TDI actions,
 * but only one per Driven lifecycle.
 */
export interface TransitionDrivenItemConfig {
  /** ID of the Driven lifecycle this action applies to */
  drivenLifecycleId: string

  /** Source state ID - items must be in this state to be transitioned */
  fromStateId: string

  /** Target state ID - state to transition items to */
  targetStateId: string

  /** Whether to validate destination state gates before transition */
  validateGates: boolean

  /** Optional filter to limit which items are affected */
  filter?: {
    itemTypes?: Array<string>
    currentStates?: Array<string>
  }
}

// ============================================
// Lifecycle Effect Types (ECO-to-Item Coordination)
// ============================================

/**
 * Change actions that can be performed on affected items in a Change Order.
 *
 * State-changing actions (configured in lifecycle's changeActionMappings):
 * - release: First release of a new item (Draft → Released)
 * - revise: Create new revision (old → Superseded, new → Released)
 * - obsolete: End-of-life an item (Released → Obsolete)
 *
 * Membership actions (no state change):
 * - add: Link existing item to BOM/design
 * - remove: Unlink item from BOM/design
 *
 * Re-exported from @/lib/types/lifecycle for backward compatibility.
 */
export type { ChangeAction } from '@/lib/types/lifecycle'

/**
 * Defines how affected items should transition through their lifecycle
 * when a workflow transition occurs on a Change Order
 */
export interface LifecycleEffect {
  id: string
  name: string // User-defined name for this effect
  changeAction: ChangeAction // Which affected item action this applies to
  lifecycleDefinitionId: string // Which lifecycle (e.g., "Parts - Default")
  fromStateId: string // Current state the item must be in
  toStateId: string // State to transition the item to
  validateGuards: boolean // Whether to check lifecycle guards before ECO transitions
}

/**
 * Result of executing lifecycle effects for a single affected item
 */
export interface LifecycleEffectResult {
  itemId: string
  itemNumber?: string
  changeAction: ChangeAction
  executedTransitions: Array<{
    fromState: string
    toState: string
    success: boolean
    error?: string
  }>
  success: boolean
  error?: string
}

// ============================================
// Approval Types
// ============================================

export interface ApprovalRequirement {
  requiredCount: number
  requiredRoles?: Array<string>
  requireAll?: boolean
}

export interface ApprovalVote {
  id: string
  workflowInstanceId: string
  transitionId: string
  userId: string
  roleId?: string | null
  vote: 'approve' | 'reject'
  comments?: string
  votedAt: Date
}

// ============================================
// State Approver Types (Definition-level)
// ============================================

/**
 * An approver assigned to a workflow state
 * Can be a user or a role
 */
export interface StateApprover {
  id: string
  workflowDefinitionId: string
  stateId: string
  approverType: 'user' | 'role'
  approverId: string
  approverName?: string // Resolved name for display
  isRequired: boolean
  createdAt: Date
}

/**
 * Input for adding an approver to a state
 */
export interface ApproverInput {
  type: 'user' | 'role'
  id: string
  isRequired: boolean
}

// ============================================
// Approval Status Types (Instance-level)
// ============================================

/**
 * Approval status grouped by state for an entire workflow instance
 */
export interface ApprovalsByState {
  [stateId: string]: ApprovalStatus
}

/**
 * Approval status for a single workflow state
 */
export interface ApprovalStatus {
  stateId: string
  stateName: string
  requiredApprovers: Array<ApproverWithStatus>
  optionalApprovers: Array<ApproverWithStatus>
  isComplete: boolean
  approvedCount: number
  requiredCount: number
}

/**
 * An approver with their current approval status
 */
export interface ApproverWithStatus {
  approverType: 'user' | 'role'
  approverId: string
  approverName: string
  isRequired: boolean
  vote?: 'approved' | 'rejected' | null
  votedBy?: { id: string; name: string }
  votedAt?: Date
  comments?: string
}

/**
 * Result of checking if a user can approve
 */
export interface CanApproveResult {
  canApprove: boolean
  asUser: boolean // Can approve as themselves
  asRoles: Array<{ id: string; name: string }> // Roles user can approve as
  alreadyVoted: boolean
  existingVote?: 'approved' | 'rejected'
}

/**
 * Status of approval completion for transition gating
 */
export interface ApprovalCompletionStatus {
  met: boolean
  required: number
  current: number
  pending: Array<{ type: 'user' | 'role'; id: string; name: string }>
}

// ============================================
// Instance Types (Runtime)
// ============================================

/**
 * Running instance of a workflow attached to an item
 */
export interface WorkflowInstance {
  id: string
  workflowDefinitionId: string
  itemId: string
  currentState: string
  startedAt: Date
  completedAt?: Date
  context?: Record<string, unknown>

  // Scope lock fields (for Driving lifecycles like ECOs)
  /** When true, no more affected items can be added to this ECO */
  scopeLocked?: boolean
  /** Timestamp when scope was locked */
  scopeLockedAt?: Date
}

/**
 * History entry for workflow transitions
 */
export interface WorkflowHistoryEntry {
  id: string
  instanceId: string
  fromState: string | null
  toState: string
  action: string
  actorId: string
  timestamp: Date
  comments?: string
  data?: Record<string, unknown>
}

// ============================================
// Guard Evaluation Context
// ============================================

/**
 * Context provided to guards during evaluation
 */
export interface GuardContext {
  item: Record<string, unknown>
  user: {
    id: string
    roles: Array<string>
  }
  workflowInstance?: WorkflowInstance
  approvals?: Array<ApprovalVote>
}

/**
 * Result of evaluating a guard
 */
export interface GuardResult {
  passed: boolean
  guardId: string
  guardName: string
  errorMessage?: string
}

// ============================================
// Validation Types
// ============================================

/**
 * Result of validating a workflow definition
 */
export interface ValidationResult {
  valid: boolean
  errors: Array<ValidationError>
  warnings: Array<ValidationWarning>
}

export interface ValidationError {
  code: string
  message: string
  path?: string
}

export interface ValidationWarning {
  code: string
  message: string
  path?: string
}

// ============================================
// Transition Types
// ============================================

/**
 * Result of attempting a transition
 */
export interface TransitionResult {
  success: boolean
  fromState: string
  toState: string
  guardResults?: Array<GuardResult>
  actionResults?: Array<ActionResult>
  lifecycleEffectResults?: Array<LifecycleEffectResult>
  error?: string
}

export interface ActionResult {
  actionId: string
  actionName: string
  success: boolean
  error?: string
  data?: Record<string, unknown>
}

// ============================================
// UI Types for React Flow
// ============================================

export interface StateNodeData {
  state: WorkflowState
  isSelected?: boolean
  onEdit?: (state: WorkflowState) => void
  onDelete?: (stateId: string) => void
}

export interface TransitionEdgeData {
  transition: WorkflowTransition
  isSelected?: boolean
  onEdit?: (transition: WorkflowTransition) => void
  onDelete?: (transitionId: string) => void
}

// ============================================
// API Types
// ============================================

export interface CreateWorkflowInput {
  name: string
  /** @deprecated Use lifecycleType instead */
  definitionType: DefinitionType
  workflowType: WorkflowType
  description?: string
  applicableItemTypes?: Array<string>
  states: Array<WorkflowState>
  transitions?: Array<WorkflowTransition>
  /** @deprecated Use TransitionDrivenItem actions on Driving lifecycle transitions instead */
  changeActionMappings?: ChangeActionMappings
  isActive?: boolean
  /** Unified lifecycle type: Free, Driven, or Driving */
  lifecycleType?: LifecycleType
  /** For Driven lifecycles: IDs of allowed Driving lifecycles */
  drivers?: Array<string>
  /** Default revision scheme for this lifecycle */
  revisionScheme?: RevisionScheme
  /** Lifecycle phases that group states into logical stages */
  phases?: Array<LifecyclePhaseConfig>
}

export interface UpdateWorkflowInput {
  name?: string
  description?: string
  applicableItemTypes?: Array<string>
  states?: Array<WorkflowState>
  transitions?: Array<WorkflowTransition>
  /** @deprecated Use TransitionDrivenItem actions on Driving lifecycle transitions instead */
  changeActionMappings?: ChangeActionMappings
  isActive?: boolean
  /** Unified lifecycle type: Free, Driven, or Driving */
  lifecycleType?: LifecycleType
  /** For Driven lifecycles: IDs of allowed Driving lifecycles */
  drivers?: Array<string>
  /** Default revision scheme for this lifecycle */
  revisionScheme?: RevisionScheme
  /** Lifecycle phases that group states into logical stages */
  phases?: Array<LifecyclePhaseConfig>
}

export interface AvailableTransition {
  transition: WorkflowTransition
  canTransition: boolean
  guardResults: Array<GuardResult>
}
