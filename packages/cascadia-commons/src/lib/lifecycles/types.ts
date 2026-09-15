// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
  ChangeActionMappings,
  LifecyclePhaseConfig,
  RevisionScheme,
} from '../types/lifecycle'

// ============================================
// Definition Types
// ============================================

export type WorkflowType = 'strict' | 'flexible'

/**
 * Unified lifecycle type that determines how a lifecycle behaves:
 * - Free: self-controlled, with manual transitions (Issues, Tools)
 * - Driven: change-order-controlled; declares its states and the
 *   changeActionMappings the merge applies at release (Parts, Documents,
 *   Requirements)
 * - Driving: a change-order approval workflow whose completion in a
 *   `finalKind: 'release'` state triggers the release (ECO workflows)
 */
export type LifecycleType = 'Free' | 'Driven' | 'Driving'

/**
 * Complete workflow/lifecycle definition stored in database
 *
 * Unified Lifecycle Model:
 * - Free lifecycles: Self-controlled with manual transitions (Issues, Tools)
 * - Driven lifecycles: ECO-controlled, declare states plus changeActionMappings
 *   that the merge applies at change-order release (Parts, Documents, Requirements)
 * - Driving lifecycles: Change-order approval workflows whose completion
 *   triggers the release (ECO Workflow, Flexible ECO)
 */
export interface LifecycleDefinition {
  id: string
  name: string
  version: number
  /**
   * `strict` or `flexible`: whether an instance may carry a structure of
   * its own (`instanceStates`/`instanceTransitions`, edited through
   * `updateInstanceStructure`). Branched on by `LifecycleInstanceService` and the
   * change-order routes. Orthogonal to `lifecycleType`, which is the
   * definition's kind. A v1 response property and a NOT NULL column; renamed
   * at v2 to `structure: 'fixed' | 'per-instance'` (remediation plan,
   * Decision 3).
   */
  workflowType: WorkflowType
  description?: string
  applicableItemTypes?: Array<string>
  states: Array<LifecycleState>

  /** Manual transitions - used by Free and Driving lifecycles */
  transitions?: Array<LifecycleTransition>

  /**
   * How ECO change actions (release/revise/obsolete/promote) move items of
   * this Driven lifecycle between states. Applied by the merge at
   * change-order release — the single mechanism for ECO-driven state change.
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
 * What finishing in this final state means.
 *
 * Driving workflows: 'release' merges ECO branches to main and assigns
 * revisions; 'cancel' archives branches without merging. Required on every
 * Driving final state.
 *
 * Free lifecycles: 'complete' marks successful completion (work orders gate
 * their traveler on transitions into such a state and stamp completedAt);
 * 'cancel' marks abandonment. Optional — a Free final that declares neither
 * simply ends the flow with no completion semantics attached.
 */
export type FinalKind = 'release' | 'cancel' | 'complete'

/**
 * State in a workflow/lifecycle
 */
export interface LifecycleState {
  id: string
  name: string
  color?: string
  description?: string
  isInitial?: boolean
  isFinal?: boolean
  /**
   * Required on final states of Driving lifecycles. The release-vs-cancel
   * decision is made from this flag alone — never from the state's name.
   */
  finalKind?: FinalKind
  position?: { x: number; y: number }
  /** ID of the lifecycle phase this state belongs to */
  phaseId?: string
}

/**
 * Transition between states
 */
export interface LifecycleTransition {
  id: string
  name: string
  fromStateId: string
  toStateId: string
  description?: string
  guards?: Array<TransitionGuard>
  actions?: Array<TransitionAction>
  labelPosition?: { x: number; y: number } // Custom label position (acts as path waypoint)
  /**
   * Minimum number of distinct approvals at the source state before this
   * transition may fire, on top of any named state approvers.
   *
   * Enforced (WI-4.3 removed it as dead, but the knob was then only available
   * on flexible instance transitions — so "require two approvals" was
   * unanswerable for the fixed ECO workflow most instances use). Composes with
   * named approvers: both gates must pass.
   */
  approvalRequirement?: ApprovalRequirement
  // allowedRoles used to live here and was never read.
}

// ============================================
// Instance-Level Workflow Types (for Flexible Workflows)
// ============================================

/**
 * Instance-level workflow state (simplified version for ad-hoc workflows)
 * Extends LifecycleState with reviewer instructions. (An `assignees` field
 * used to live here — never read anywhere; instance approvers in
 * workflow_instance_approvers are the enforced mechanism.)
 */
export interface InstanceState extends LifecycleState {
  /** Instructions for reviewers at this state */
  instructions?: string
}

/**
 * Instance-level transition (simplified - no guards, only approvals)
 * Used for flexible workflows where users can define custom routing
 */
export interface InstanceTransition {
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
 * Used by `LifecycleInstanceService` to get the current structure of an instance
 */
export interface EffectiveLifecycleStructure {
  states: Array<LifecycleState>
  transitions: Array<LifecycleTransition | InstanceTransition>
  /** True if using instance-level overrides, false if using definition */
  isInstanceLevel: boolean
  /** True if the workflow can be edited (flexible + not completed) */
  canEdit: boolean
  /** The underlying workflow definition (for lifecycle effects, etc.) */
  definition: LifecycleDefinition
}

// ============================================
// Guard Types
// ============================================

export type GuardType = 'field_value' | 'user_role'
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
  config: FieldValueConfig | UserRoleConfig
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

// The approval_count guard type is gone (WI-4.3): it was dead three
// independent ways (nothing populated context.approvals, the vote strings
// never matched, and role names were compared to role IDs). Approval gating
// is state approvers plus the instance-transition requiredCount.

// ============================================
// Action Types
// ============================================

export type ActionType = 'send_notification' | 'update_field'

export type ActionExecuteOn = 'before' | 'after'

/**
 * Action that executes during a transition
 */
export interface TransitionAction {
  id: string
  name: string
  type: ActionType
  executeOn: ActionExecuteOn
  config: SendNotificationConfig | UpdateFieldConfig
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

// create_task was removed rather than shipped as a NotImplementedError in the
// config UI (decision D5) — reintroduce only with a real design.

/**
 * Change actions a change order can list an affected item for — release,
 * revise, obsolete, promote — each configured in the item's lifecycle
 * changeActionMappings and applied by the merge at release. The retired
 * membership actions (`add`, `remove`) are not among them: BOM membership
 * is a branch edit the merge releases with the branch.
 *
 * Re-exported from @/lib/types/lifecycle, where the schema lives.
 */
export type { ChangeAction } from '../types/lifecycle'

// ============================================
// Approval Types
// ============================================

/**
 * Minimum number of distinct active 'approved' votes required at the
 * transition's source state before the transition may be taken. Carried on
 * instance-level transitions and enforced by the engine (WI-4.2); composes
 * with named approvers — both must be satisfied.
 *
 * (requiredRoles/requireAll were removed: they were never enforced, and
 * role-scoped requirements are expressed as role approvers instead.)
 */
export interface ApprovalRequirement {
  requiredCount: number
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

/**
 * An approver assigned to a state on a specific workflow instance
 * (WI-4.2). Instance approvers cover the states flexible workflows add at
 * runtime — definition-keyed approvers can never reference those. Gating
 * uses the union of definition-level and instance-level approvers.
 */
export interface InstanceApprover {
  id: string
  workflowInstanceId: string
  stateId: string
  approverType: 'user' | 'role'
  approverId: string
  approverName?: string // Resolved name for display
  isRequired: boolean
  createdAt: Date
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
  /**
   * Distinct users with an active 'approved' vote at this state,
   * regardless of whether they are named approvers. Feeds the
   * instance-transition requiredCount gate (WI-4.2).
   */
  totalApproved: number
}

// ============================================
// Instance Types (Runtime)
// ============================================

/**
 * Running instance of a workflow attached to an item
 */
/**
 * Options for LifecycleInstanceService.transition(). Used by the change-order release
 * orchestrator to interlock irreversible work (merge) with the state write.
 */
/**
 * The in-flight transition an action executes for. Passed into action
 * execution explicitly — "before" actions run ahead of the history write,
 * so reading the latest history entry there would yield the *previous*
 * transition's states.
 */
export interface TransitionFlowContext {
  fromStateId: string
  toStateId: string
  /** Effective states of the instance, for resolving display names */
  states: Array<LifecycleState>
}

export interface LifecycleInstance {
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

  /**
   * Set while a release/cancel of this instance is in flight. Blocks all
   * other transitions until cleared (or until the claim goes stale).
   */
  releasingAt?: Date
}

/**
 * History entry for workflow transitions
 */
export interface LifecycleHistoryEntry {
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
  workflowInstance?: LifecycleInstance
}

/**
 * What a caller supplies for guard evaluation. The service loads the item
 * from the instance when it is left out, and resolves the actor's roles when
 * they are. The preview routes used to pass `item: {}` "to be populated by
 * the service" while the execution path loaded the item itself, so a
 * `field_value` guard failed in the preview and passed on execution.
 */
export interface GuardContextInput {
  item?: Record<string, unknown>
  user: {
    id: string
    roles?: Array<string>
  }
  workflowInstance?: LifecycleInstance
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
  state: LifecycleState
  isSelected?: boolean
  onEdit?: (state: LifecycleState) => void
  onDelete?: (stateId: string) => void
}

export interface TransitionEdgeData {
  transition: LifecycleTransition
  isSelected?: boolean
  onEdit?: (transition: LifecycleTransition) => void
  onDelete?: (transitionId: string) => void
}

// ============================================
// API Types
// ============================================

export interface CreateLifecycleInput {
  name: string
  /**
   * `strict` or `flexible` — see `LifecycleDefinition.workflowType`.
   * Required; `lifecycleType` is the other axis, not a replacement.
   */
  workflowType: WorkflowType
  description?: string
  applicableItemTypes?: Array<string>
  states: Array<LifecycleState>
  transitions?: Array<LifecycleTransition>
  /** ECO change-action mappings, applied by the merge at release */
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

export interface UpdateLifecycleInput {
  name?: string
  description?: string
  applicableItemTypes?: Array<string>
  states?: Array<LifecycleState>
  transitions?: Array<LifecycleTransition>
  /** ECO change-action mappings, applied by the merge at release */
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
  transition: LifecycleTransition
  canTransition: boolean
  guardResults: Array<GuardResult>
}
