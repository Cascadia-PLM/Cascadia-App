// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'
import { db, withTx } from '../db'
import { lifecycleHistory, lifecycleInstances } from '../db/schema/lifecycles'
import { items } from '../db/schema/items'
import { LIFECYCLE_TRANSITIONED, publishDomainEvent } from '../events'
import {
  LIFECYCLE_TRANSITION,
  dispatchGuard,
  hasGuardExtensions,
} from '../extensions'
import { permissionService } from '../auth/permission-service'
import { AlreadyExistsError, NotFoundError, ValidationError } from '../errors'
import { LifecycleService } from '../services/LifecycleService'
import { ItemTypeRegistry } from '../items/registry'
import { GuardEvaluator } from './GuardEvaluator'
import { isDrivingDefinition, resolveLifecycleType } from './normalize'
import {
  LifecycleDefinitionService,
  UPDATE_FIELD_ALLOWED_COLUMNS,
} from './LifecycleDefinitionService'
import type { TransactionClient } from '../db'
import type { LifecycleTransitionIntent } from '../extensions'
import type {
  ActionResult,
  ApprovalRequirement,
  AvailableTransition,
  EffectiveLifecycleStructure,
  FinalKind,
  GuardContext,
  GuardContextInput,
  GuardResult,
  InstanceTransition,
  LifecycleHistoryEntry,
  LifecycleInstance,
  LifecycleState,
  LifecycleTransition,
  LifecycleType,
  SendNotificationConfig,
  TransitionAction,
  TransitionExecutionOptions,
  TransitionFlowContext,
  TransitionResult,
} from './types'
import { resolveChangeOrderProgram } from '@/lib/events/program-scope'
import { takeFirst } from '@/lib/db/take-first'

/**
 * Lifecycle instances: starting one for an item, the transitions it can
 * take and takes, the release claim, per-instance structure edits on a
 * flexible definition, history, the actions a transition executes, and the
 * Free-lifecycle item path that drives all of it. Definitions come from
 * `LifecycleDefinitionService`. The claim/CAS protocol in `transition` is
 * the one the audit verified and is unchanged by the split (remediation
 * plan CM-22).
 */
export class LifecycleInstanceService {
  // ============================================
  // Workflow Instance Management
  // ============================================

  /**
   * Start a workflow instance for an item.
   * For flexible workflows, copies the definition structure to the instance.
   *
   * The instance row and its 'started' history row commit together — in the
   * caller's transaction when it passes one (a change order stamps its own
   * state in the same commit), otherwise in this method's own. They were two
   * statements, so a failure between them left an instance with no record of
   * having started.
   */
  static async startInstance(
    workflowDefinitionId: string,
    itemId: string,
    context?: Record<string, unknown>,
    tx?: TransactionClient,
  ): Promise<LifecycleInstance> {
    const definition =
      await LifecycleDefinitionService.getById(workflowDefinitionId)
    if (!definition) {
      throw new NotFoundError('Workflow definition', workflowDefinitionId)
    }

    const initialState = definition.states.find((s) => s.isInitial)
    if (!initialState) {
      throw new ValidationError('Workflow has no initial state')
    }

    // For flexible workflows, copy the structure to the instance
    const isFlexible = definition.workflowType === 'flexible'

    return withTx(tx, async (client) => {
      let instance
      try {
        instance = takeFirst(
          await client
            .insert(lifecycleInstances)
            .values({
              workflowDefinitionId,
              itemId,
              currentState: initialState.id,
              context: context || {},
              // Initialize instance structure for flexible workflows
              instanceStates: isFlexible ? definition.states : null,
              instanceTransitions: isFlexible
                ? (definition.transitions ?? [])
                : null,
            })
            .returning(),
        )
      } catch (error) {
        // The partial unique index guarantees one active instance per item;
        // translate the violation so racing creates get a clean 409.
        // Drizzle wraps driver errors — the Postgres fields live on `cause`.
        const pgError = ((error as { cause?: unknown } | null)?.cause ??
          error) as {
          code?: string
          constraint_name?: string
          constraint?: string
        } | null
        if (
          pgError?.code === '23505' &&
          (pgError.constraint_name ?? pgError.constraint) ===
            'workflow_instances_one_active_per_item'
        ) {
          throw new AlreadyExistsError('Workflow', itemId)
        }
        throw error
      }

      await this.recordHistory(client, {
        instanceId: instance.id,
        fromState: null,
        toState: initialState.id,
        action: 'started',
        actorId: (context as any)?.actorId || null,
        data: {
          definitionName: definition.name,
          isFlexible,
        },
      })

      return {
        id: instance.id,
        workflowDefinitionId: instance.workflowDefinitionId!,
        itemId: instance.itemId!,
        currentState: instance.currentState!,
        startedAt: instance.startedAt,
        completedAt: instance.completedAt ?? undefined,
        context: instance.context as Record<string, unknown>,
      }
    })
  }

  /**
   * Get workflow instance by ID
   */
  static async getInstance(
    instanceId: string,
  ): Promise<LifecycleInstance | null> {
    const results = await db
      .select()
      .from(lifecycleInstances)
      .where(eq(lifecycleInstances.id, instanceId))
      .limit(1)

    const result = results[0]
    if (!result) return null
    return {
      id: result.id,
      workflowDefinitionId: result.workflowDefinitionId!,
      itemId: result.itemId!,
      currentState: result.currentState!,
      startedAt: result.startedAt,
      completedAt: result.completedAt ?? undefined,
      context: result.context as Record<string, unknown>,
      scopeLocked: result.scopeLocked ?? false,
      scopeLockedAt: result.scopeLockedAt ?? undefined,
      releasingAt: result.releasingAt ?? undefined,
    }
  }

  /**
   * Get workflow instance for an item
   */
  static async getInstanceByItemId(
    itemId: string,
  ): Promise<LifecycleInstance | null> {
    const instanceResults = await db
      .select()
      .from(lifecycleInstances)
      .where(eq(lifecycleInstances.itemId, itemId))
      .orderBy(desc(lifecycleInstances.startedAt))
      .limit(1)

    const result = instanceResults[0]
    if (!result) return null
    return {
      id: result.id,
      workflowDefinitionId: result.workflowDefinitionId!,
      itemId: result.itemId!,
      currentState: result.currentState!,
      startedAt: result.startedAt,
      completedAt: result.completedAt ?? undefined,
      context: result.context as Record<string, unknown>,
      scopeLocked: result.scopeLocked ?? false,
      scopeLockedAt: result.scopeLockedAt ?? undefined,
      releasingAt: result.releasingAt ?? undefined,
    }
  }

  /**
   * Get workflow history for an instance
   */
  static async getHistory(
    instanceId: string,
  ): Promise<Array<LifecycleHistoryEntry>> {
    const results = await db
      .select()
      .from(lifecycleHistory)
      .where(eq(lifecycleHistory.instanceId, instanceId))
      .orderBy(desc(lifecycleHistory.timestamp))

    return results.map((r) => ({
      id: r.id,
      instanceId: r.instanceId,
      fromState: r.fromState,
      toState: r.toState!,
      action: r.action!,
      actorId: r.actorId!,
      timestamp: r.timestamp,
      comments: r.comments ?? undefined,
      data: r.data as Record<string, unknown>,
    }))
  }

  // ============================================
  // Flexible Workflow Methods
  // ============================================

  /**
   * Get the effective workflow structure for an instance.
   * For flexible workflows with instance overrides, returns instance structure.
   * Otherwise returns definition structure.
   */
  static async getEffectiveStructure(
    instanceId: string,
  ): Promise<EffectiveLifecycleStructure> {
    const instance = await this.getInstanceRaw(instanceId)
    if (!instance) {
      throw new NotFoundError('Workflow instance', instanceId)
    }

    const definition = await LifecycleDefinitionService.getById(
      instance.workflowDefinitionId!,
    )
    if (!definition) {
      throw new NotFoundError('Workflow definition')
    }

    const isFlexible = definition.workflowType === 'flexible'
    const hasInstanceOverrides = instance.instanceStates !== null

    if (isFlexible && hasInstanceOverrides) {
      return {
        states: instance.instanceStates as Array<LifecycleState>,
        transitions: instance.instanceTransitions as Array<InstanceTransition>,
        isInstanceLevel: true,
        canEdit: !instance.completedAt, // Can edit if not completed
        definition,
      }
    }

    return {
      states: definition.states,
      transitions: definition.transitions ?? [],
      isInstanceLevel: false,
      canEdit: isFlexible && !instance.completedAt,
      definition,
    }
  }

  /**
   * Update instance-level workflow structure.
   * Validates that the update is safe (current state still exists, etc.)
   */
  static async updateInstanceStructure(
    instanceId: string,
    states: Array<LifecycleState>,
    transitions: Array<InstanceTransition>,
    actorId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const instance = await this.getInstanceRaw(instanceId)
    if (!instance) {
      return { success: false, error: 'Workflow instance not found' }
    }

    const definition = await LifecycleDefinitionService.getById(
      instance.workflowDefinitionId!,
    )
    if (!definition || definition.workflowType !== 'flexible') {
      return { success: false, error: 'Workflow is not flexible' }
    }

    if (instance.completedAt) {
      return { success: false, error: 'Cannot modify completed workflow' }
    }

    // Validate: current state must still exist
    const currentStateExists = states.some(
      (s) => s.id === instance.currentState,
    )
    if (!currentStateExists) {
      return {
        success: false,
        error: `Cannot remove current state "${instance.currentState}"`,
      }
    }

    // Validate: must have exactly one initial state
    const initialStates = states.filter((s) => s.isInitial)
    if (initialStates.length !== 1) {
      return { success: false, error: 'Must have exactly one initial state' }
    }

    // Validate: must have at least one final state
    const finalStates = states.filter((s) => s.isFinal)
    if (finalStates.length === 0) {
      return { success: false, error: 'Must have at least one final state' }
    }

    // Driving lifecycles: instance-level final states must declare finalKind
    // just like definition-level ones — transitions into a final state fail
    // closed without it
    if (isDrivingDefinition(definition)) {
      for (const finalState of finalStates) {
        if (
          finalState.finalKind !== 'release' &&
          finalState.finalKind !== 'cancel'
        ) {
          return {
            success: false,
            error: `Final state "${finalState.name}" must declare whether completing there releases or cancels the change order (finalKind)`,
          }
        }
      }
    }

    // Validate: all transitions reference valid states
    for (const transition of transitions) {
      const fromExists = states.some((s) => s.id === transition.fromStateId)
      const toExists = states.some((s) => s.id === transition.toStateId)
      if (!fromExists || !toExists) {
        return {
          success: false,
          error: `Transition "${transition.name}" references invalid state`,
        }
      }
    }

    // Validate: current state must have at least one outgoing transition
    // (unless it's a final state)
    const currentState = states.find((s) => s.id === instance.currentState)
    if (currentState && !currentState.isFinal) {
      const hasOutgoing = transitions.some(
        (t) => t.fromStateId === instance.currentState,
      )
      if (!hasOutgoing) {
        return {
          success: false,
          error: 'Current state must have at least one outgoing transition',
        }
      }
    }

    // The structure and the history row that says who changed it commit
    // together: as separate statements, a failed history write left the
    // instance restructured with no record of the edit
    await db.transaction(async (tx) => {
      await tx
        .update(lifecycleInstances)
        .set({
          instanceStates: states,
          instanceTransitions: transitions,
        })
        .where(eq(lifecycleInstances.id, instanceId))

      await this.recordHistory(tx, {
        instanceId,
        fromState: instance.currentState,
        toState: instance.currentState, // State didn't change
        action: 'workflow_structure_modified',
        actorId,
        comments: `Workflow structure updated: ${states.length} states, ${transitions.length} transitions`,
        data: {
          stateCount: states.length,
          transitionCount: transitions.length,
          stateNames: states.map((s) => s.name),
        },
      })
    })

    return { success: true }
  }

  /**
   * Check if a workflow instance is flexible and editable
   */
  static async isFlexibleAndEditable(instanceId: string): Promise<boolean> {
    const instance = await this.getInstanceRaw(instanceId)
    if (!instance || instance.completedAt) return false

    const definition = await LifecycleDefinitionService.getById(
      instance.workflowDefinitionId!,
    )
    return definition?.workflowType === 'flexible'
  }

  /**
   * Get raw workflow instance data (including instanceStates/instanceTransitions)
   */
  private static async getInstanceRaw(instanceId: string) {
    const results = await db
      .select()
      .from(lifecycleInstances)
      .where(eq(lifecycleInstances.id, instanceId))
      .limit(1)

    return results.length > 0 ? results[0] : null
  }

  /**
   * Check approval requirement for an instance-level transition
   * Now uses ApprovalService for real approval tracking
   */
  private static async checkApprovalRequirement(
    instanceId: string,
    stateId: string,
    requirement: ApprovalRequirement,
  ): Promise<{
    met: boolean
    required: number
    current: number
    /** Set when the check itself failed (which blocks the transition) */
    checkError?: string
  }> {
    const { ApprovalService } = await import('./ApprovalService')

    try {
      const status = await ApprovalService.areApprovalsComplete(
        instanceId,
        stateId,
      )

      // Named approvers first: every required approver (definition- or
      // instance-level) must have an active approved vote
      if (!status.met) {
        return {
          met: false,
          required: status.required,
          current: status.current,
        }
      }

      // Then the transition's requiredCount (WI-4.2): a minimum number of
      // distinct active approved votes at the source state, from anyone.
      // Composes with named approvers — both gates must pass.
      const requiredCount = requirement.requiredCount || 0
      if (status.totalApproved < requiredCount) {
        return {
          met: false,
          required: requiredCount,
          current: status.totalApproved,
        }
      }

      return {
        met: true,
        required: Math.max(status.required, requiredCount),
        current: Math.max(status.current, status.totalApproved),
      }
    } catch (error) {
      // Fail closed: if approvals cannot be verified, the transition is
      // blocked. A DB failure during the check must never allow a transition
      // that configured approvers would have gated.
      return {
        met: false,
        required: requirement.requiredCount || 0,
        current: 0,
        checkError:
          error instanceof Error ? error.message : 'Approval check failed',
      }
    }
  }

  // ============================================
  // Transition Operations
  // ============================================

  /**
   * Get available transitions for a workflow instance
   * Uses effective structure for flexible workflows
   *
   * Guards are evaluated against the same context `transition()` builds —
   * the item loaded from the instance, the actor's roles resolved — so the
   * preview predicts what execution will decide.
   */
  static async getAvailableTransitions(
    instanceId: string,
    context: GuardContextInput,
  ): Promise<Array<AvailableTransition>> {
    const instance = await this.getInstance(instanceId)
    if (!instance) {
      throw new NotFoundError('Workflow instance', instanceId)
    }
    const guardContext = await this.buildGuardContext(instance, context)

    // Use effective structure instead of definition directly
    const effectiveStructure = await this.getEffectiveStructure(instanceId)

    // Find transitions from current state
    const transitions = effectiveStructure.transitions.filter(
      (t) => t.fromStateId === instance.currentState,
    )

    // Evaluate guards for each transition
    const available: Array<AvailableTransition> = []

    for (const transition of transitions) {
      if (effectiveStructure.isInstanceLevel) {
        // Instance-level: no guards, just check approvals if required
        const guardResults: Array<GuardResult> = []
        const instanceTransition = transition

        // Check approvals for the current state (fromStateId)
        const approvalResult = await this.checkApprovalRequirement(
          instanceId,
          transition.fromStateId,
          instanceTransition.approvalRequirement ?? { requiredCount: 0 },
        )
        if (!approvalResult.met) {
          guardResults.push({
            guardId: 'approval-requirement',
            guardName: 'Approval Requirement',
            passed: false,
            errorMessage: `Requires ${approvalResult.required} approvals, has ${approvalResult.current}`,
          })
        }

        available.push({
          transition: transition,
          canTransition: guardResults.every((r) => r.passed),
          guardResults,
        })
      } else {
        // Definition-level: evaluate guards and check state approvers
        const workflowTransition = transition as LifecycleTransition
        const guardResults = await GuardEvaluator.evaluateAll(
          workflowTransition.guards || [],
          guardContext,
        )

        // Also check state-level approvers and the transition's requiredCount,
        // so the preview predicts what transition() will enforce
        const approvalResult = await this.checkApprovalRequirement(
          instanceId,
          transition.fromStateId,
          workflowTransition.approvalRequirement ?? { requiredCount: 0 },
        )
        if (!approvalResult.met) {
          guardResults.push({
            guardId: 'state-approval-requirement',
            guardName: 'State Approval Requirement',
            passed: false,
            errorMessage: `Requires ${approvalResult.required} approvals, has ${approvalResult.current}`,
          })
        }

        available.push({
          transition: workflowTransition,
          canTransition: guardResults.every((r) => r.passed),
          guardResults,
        })
      }
    }

    // The second dispatch, on the read path, in an explicit preview mode.
    //
    // This method's own doc comment says the preview predicts what execution
    // will decide, and the interface is built from it — so a guard bound only
    // to `transition()` would make the UI offer a transition that then fails,
    // which is the exact divergence this layer exists to remove.
    //
    // It imposes a contract worth stating out loud rather than leaving to be
    // discovered: **a `guard` handler must be side-effect-free.** This is the
    // one sanctioned read-path dispatch in the system, and naming it as such
    // is what keeps it from looking like a violated non-goal.
    if (hasGuardExtensions(LIFECYCLE_TRANSITION)) {
      for (const entry of available) {
        const refusals = await dispatchGuard(
          LIFECYCLE_TRANSITION,
          await this.buildTransitionIntent(
            instance,
            entry.transition.toStateId,
            entry.transition,
            effectiveStructure.states,
          ),
          { db, actorId: context.user.id, preview: true },
        )
        if (refusals.length === 0) continue
        entry.guardResults = [
          ...entry.guardResults,
          ...refusals.map((refusal) => ({
            guardId: refusal.extensionId,
            guardName: refusal.extensionId,
            passed: false,
            errorMessage: refusal.reason,
          })),
        ]
        entry.canTransition = false
      }
    }

    return available
  }

  /**
   * The intent a `lifecycle.transition` guard is handed.
   *
   * Built in one place because two call sites use it — `transition()` and the
   * preview in `getAvailableTransitions` — and the preview's own doc comment
   * promises it predicts what execution will decide. Two hand-built intents
   * would be two chances for that promise to quietly stop holding.
   *
   * The item's type costs a read that `transition()` does not otherwise do
   * before its write, so every caller checks `hasGuardExtensions` first.
   */
  private static async buildTransitionIntent(
    instance: LifecycleInstance,
    toStateId: string,
    transition: { id: string; name: string },
    states: Array<LifecycleState>,
    comments?: string,
  ): Promise<LifecycleTransitionIntent> {
    const item = await this.getItemData(instance.itemId)
    const target = states.find((state) => state.id === toStateId)
    return {
      instanceId: instance.id,
      itemId: instance.itemId,
      itemType: typeof item?.itemType === 'string' ? item.itemType : '',
      fromState: instance.currentState,
      toState: toStateId,
      toStateIsFinal: target?.isFinal === true,
      toStateFinalKind: target?.finalKind ?? null,
      transitionId: transition.id,
      transitionName: transition.name,
      comments: comments ?? null,
    }
  }

  /**
   * Check if a specific transition is allowed
   */
  static async canTransition(
    instanceId: string,
    toStateId: string,
    context: GuardContextInput,
  ): Promise<{ allowed: boolean; reasons: Array<string> }> {
    const available = await this.getAvailableTransitions(instanceId, context)

    const transition = available.find(
      (a) => a.transition.toStateId === toStateId,
    )

    if (!transition) {
      return {
        allowed: false,
        reasons: ['No transition exists to this state from current state'],
      }
    }

    if (!transition.canTransition) {
      return {
        allowed: false,
        reasons: transition.guardResults
          .filter((r) => !r.passed)
          .map((r) => r.errorMessage || `Guard "${r.guardName}" failed`),
      }
    }

    return { allowed: true, reasons: [] }
  }

  /**
   * How long a release claim blocks other transitions before it is
   * considered stale (covers a process that died mid-release).
   */
  static readonly RELEASE_CLAIM_TIMEOUT_MS = 15 * 60 * 1000

  /**
   * Claim exclusive rights to complete this instance (release or cancel).
   * Compare-and-swap: succeeds only if the instance is still in
   * expectedState, not completed, and not already claimed (or the existing
   * claim is stale). While held, all other transitions are blocked.
   */
  static async claimRelease(
    instanceId: string,
    expectedState: string,
  ): Promise<{ claimed: boolean; error?: string }> {
    const staleBefore = new Date(Date.now() - this.RELEASE_CLAIM_TIMEOUT_MS)
    const rows = await db
      .update(lifecycleInstances)
      .set({ releasingAt: new Date() })
      .where(
        and(
          eq(lifecycleInstances.id, instanceId),
          eq(lifecycleInstances.currentState, expectedState),
          isNull(lifecycleInstances.completedAt),
          or(
            isNull(lifecycleInstances.releasingAt),
            lt(lifecycleInstances.releasingAt, staleBefore),
          ),
        ),
      )
      .returning({ id: lifecycleInstances.id })

    if (rows.length > 0) {
      return { claimed: true }
    }

    // Claim failed — report why for a useful error message
    const current = await this.getInstance(instanceId)
    if (!current) {
      return { claimed: false, error: 'Workflow instance not found' }
    }
    if (current.completedAt) {
      return { claimed: false, error: 'Workflow is already completed' }
    }
    if (current.currentState !== expectedState) {
      return {
        claimed: false,
        error: `Workflow is in state "${current.currentState}", expected "${expectedState}"`,
      }
    }
    return {
      claimed: false,
      error:
        'A release of this workflow is already in progress (claims expire after ' +
        `${this.RELEASE_CLAIM_TIMEOUT_MS / 60_000} minutes if the releasing process dies)`,
    }
  }

  /**
   * Release a claim taken by claimRelease (after a failed close/cancel),
   * making the instance transitionable again.
   */
  static async releaseClaim(instanceId: string): Promise<void> {
    await db
      .update(lifecycleInstances)
      .set({ releasingAt: null })
      .where(eq(lifecycleInstances.id, instanceId))
  }

  /**
   * Directly set an instance's current state without a transition, recording
   * an audit entry. Used by the Free-lifecycle transition endpoint to adopt
   * an item's stored state when it diverges from a lazily-created instance —
   * items that predate the endpoint had their state written directly, so the
   * fresh instance starts at the initial state while the item may not be
   * there anymore.
   */
  static async adoptInstanceState(
    instanceId: string,
    stateId: string,
    actorId: string,
  ): Promise<void> {
    const instance = await this.getInstance(instanceId)
    if (!instance || instance.currentState === stateId) return

    await db
      .update(lifecycleInstances)
      .set({ currentState: stateId })
      .where(eq(lifecycleInstances.id, instanceId))

    await db.insert(lifecycleHistory).values({
      instanceId,
      fromState: instance.currentState,
      toState: stateId,
      action: 'state_adopted',
      actorId,
      data: {
        reason:
          'Instance synchronized to the item state recorded before the transition endpoint existed',
      },
    })
  }

  /**
   * Execute a transition
   * Uses effective structure for flexible workflows
   */
  static async transition(
    instanceId: string,
    toStateId: string,
    actorId: string,
    comments?: string,
    options?: TransitionExecutionOptions,
  ): Promise<TransitionResult> {
    const instance = await this.getInstance(instanceId)
    if (!instance) {
      return {
        success: false,
        fromState: '',
        toState: toStateId,
        error: 'Workflow instance not found',
      }
    }

    // Use effective structure
    const effectiveStructure = await this.getEffectiveStructure(instanceId)
    const definitionIsDriving = isDrivingDefinition(
      effectiveStructure.definition,
    )

    // Completed DRIVING workflows are terminal: a merged or cancelled change
    // order must never reopen via a plain transition. Free lifecycles may
    // legitimately define transitions out of final states (reopening a
    // Closed issue), so they are exempt — leaving a final state clears
    // completedAt again below.
    if (instance.completedAt && definitionIsDriving) {
      return {
        success: false,
        fromState: instance.currentState,
        toState: toStateId,
        error: 'Workflow is already completed and cannot be transitioned',
      }
    }

    // While a release claim is held, only the claim owner may transition
    if (
      !options?.ownedClaim &&
      instance.releasingAt &&
      Date.now() - instance.releasingAt.getTime() <
        LifecycleInstanceService.RELEASE_CLAIM_TIMEOUT_MS
    ) {
      return {
        success: false,
        fromState: instance.currentState,
        toState: toStateId,
        error:
          'A release of this workflow is already in progress (claims expire after ' +
          `${LifecycleInstanceService.RELEASE_CLAIM_TIMEOUT_MS / 60_000} minutes if the releasing process dies)`,
      }
    }

    // Find the transition
    const transition = effectiveStructure.transitions.find(
      (t) =>
        t.fromStateId === instance.currentState && t.toStateId === toStateId,
    )

    if (!transition) {
      return {
        success: false,
        fromState: instance.currentState,
        toState: toStateId,
        error: 'No valid transition from current state to target state',
      }
    }

    // For instance-level, only check approval requirements
    // For definition-level, check all guards
    const guardResults: Array<GuardResult> = []

    if (effectiveStructure.isInstanceLevel) {
      // Check approvals for the current state (fromStateId): named
      // approvers plus this transition's own requiredCount (WI-4.2)
      const approvalResult = await this.checkApprovalRequirement(
        instanceId,
        instance.currentState,
        transition.approvalRequirement ?? {
          requiredCount: 0,
        },
      )
      if (!approvalResult.met) {
        return {
          success: false,
          fromState: instance.currentState,
          toState: toStateId,
          error: approvalResult.checkError
            ? `Could not verify approvals: ${approvalResult.checkError}`
            : `Approval requirement not met: ${approvalResult.current}/${approvalResult.required}`,
          guardResults: [
            {
              guardId: 'approval-requirement',
              guardName: 'Approval Requirement',
              passed: false,
              errorMessage: approvalResult.checkError
                ? `Approval verification failed: ${approvalResult.checkError}`
                : `Requires ${approvalResult.required} approvals`,
            },
          ],
        }
      }
    } else {
      // Definition-level: evaluate guards
      const workflowTransition = transition as LifecycleTransition

      // The same context the preview evaluates against
      const context = await this.buildGuardContext(instance, {
        user: { id: actorId },
      })

      const results = await GuardEvaluator.evaluateAll(
        workflowTransition.guards || [],
        context,
      )
      guardResults.push(...results)

      const failedGuards = results.filter((r) => !r.passed)
      if (failedGuards.length > 0) {
        return {
          success: false,
          fromState: instance.currentState,
          toState: toStateId,
          guardResults,
          error: failedGuards
            .map((g) => g.errorMessage || `Guard "${g.guardName}" failed`)
            .join('; '),
        }
      }

      // Named state approvers, plus this transition's own requiredCount
      const approvalResult = await this.checkApprovalRequirement(
        instanceId,
        instance.currentState,
        workflowTransition.approvalRequirement ?? { requiredCount: 0 },
      )
      if (!approvalResult.met) {
        return {
          success: false,
          fromState: instance.currentState,
          toState: toStateId,
          guardResults: [
            {
              guardId: 'state-approval-requirement',
              guardName: 'State Approval Requirement',
              passed: false,
              errorMessage: approvalResult.checkError
                ? `Approval verification failed: ${approvalResult.checkError}`
                : `Requires ${approvalResult.required} approvals, has ${approvalResult.current}`,
            },
          ],
          error: approvalResult.checkError
            ? `Could not verify approvals: ${approvalResult.checkError}`
            : `State approval requirement not met: ${approvalResult.current}/${approvalResult.required}`,
        }
      }
    }

    // The `lifecycle.transition` guard, dispatched **after** the if/else above
    // so that both arms reach it.
    //
    // Placing it beside `GuardEvaluator.evaluateAll` would have been the
    // obvious spot and would have been wrong: that call lives only in the
    // definition-level `else`, so extension coverage would have become
    // conditional on `isInstanceLevel` — an administrator-editable property of
    // the instance. A rule that stops applying because somebody switched a
    // workflow to instance-level is not a rule.
    //
    // This is also the one site that translates rather than throws: a refusal
    // is folded into `guardResults` as a synthetic entry carrying the
    // extension's id, exactly as core already does for the
    // approval-requirement check, so the transition endpoint's failure
    // vocabulary is unchanged.
    if (hasGuardExtensions(LIFECYCLE_TRANSITION)) {
      const refusals = await dispatchGuard(
        LIFECYCLE_TRANSITION,
        await this.buildTransitionIntent(
          instance,
          toStateId,
          transition,
          effectiveStructure.states,
          comments,
        ),
        { db, actorId },
      )
      if (refusals.length > 0) {
        const refusalResults: Array<GuardResult> = refusals.map((refusal) => ({
          guardId: refusal.extensionId,
          guardName: refusal.extensionId,
          passed: false,
          errorMessage: refusal.reason,
        }))
        return {
          success: false,
          fromState: instance.currentState,
          toState: toStateId,
          guardResults: [...guardResults, ...refusalResults],
          error: refusals.map((refusal) => refusal.reason).join('; '),
        }
      }
    }

    // Execute "before" actions (definition-level only)
    const beforeResults: Array<ActionResult> = []
    if (!effectiveStructure.isInstanceLevel) {
      const workflowTransition = transition as LifecycleTransition
      const beforeActions =
        workflowTransition.actions?.filter((a) => a.executeOn === 'before') ||
        []

      for (const action of beforeActions) {
        const result = await this.executeAction(action, instance, actorId, {
          fromStateId: instance.currentState,
          toStateId,
          states: effectiveStructure.states,
        })
        beforeResults.push(result)
        if (!result.success) {
          return {
            success: false,
            fromState: instance.currentState,
            toState: toStateId,
            guardResults,
            actionResults: beforeResults,
            error: `Before action "${action.name}" failed: ${result.error}`,
          }
        }
      }
    }

    // Interlock: run caller-supplied irreversible work (e.g. ECO merge)
    // before any state write. If it throws, the workflow state is untouched
    // and the whole transition is retryable.
    if (options?.beforeFinalize) {
      await options.beforeFinalize()
    }

    // Find target state for metadata
    const targetState = effectiveStructure.states.find(
      (s) => s.id === toStateId,
    )
    const isComplete = targetState?.isFinal ?? false

    // Check if we should lock scope (for Driving lifecycles)
    // Scope is locked when leaving the initial state for the first time
    const currentStateObj = effectiveStructure.states.find(
      (s) => s.id === instance.currentState,
    )
    const drivesItemLifecycles =
      effectiveStructure.definition.lifecycleType === 'Driving'
    const shouldLockScope =
      drivesItemLifecycles &&
      currentStateObj?.isInitial &&
      !instance.scopeLocked

    // Rework reopens scope. A workflow that can send a change order back to
    // its initial state ("Return to Draft") is asking for the scope to be
    // corrected there - so leaving the lock set made that transition a trap:
    // the change order could no longer accept the items it was sent back to
    // add, and cancel-and-recreate was the only way out.
    const targetStateObj = effectiveStructure.states.find(
      (s) => s.id === toStateId,
    )
    const shouldUnlockScope =
      drivesItemLifecycles &&
      targetStateObj?.isInitial === true &&
      instance.scopeLocked === true

    // The state write and everything that must hold alongside it commit
    // together or not at all: the compare-and-swap on the instance, the votes
    // it supersedes, the item's mirrored `state`, the history row, and the
    // caller's own bookkeeping (`afterFinalize`). These ran as separate
    // statements, so a failure part-way left the instance at its new state
    // with the item and the history still describing the old one — and for a
    // change order, whose merge had already committed in `beforeFinalize`, a
    // workflow sitting at its final state with no record of how it got there.
    // `beforeFinalize` deliberately stays outside: the merge it runs commits
    // on its own terms and cannot nest here.
    const stateWritten = await db.transaction(async (tx) => {
      // Compare-and-swap on the state we read: if a concurrent transition won
      // the race, this matches zero rows and we abort with no writes instead
      // of double-firing.
      const casRows = await tx
        .update(lifecycleInstances)
        .set({
          currentState: toStateId,
          // Driving lifecycles: completedAt is only ever set, never cleared —
          // completed instances are rejected at the top of this method. Free
          // lifecycles clear it when a transition leaves a final state (reopen).
          ...(isComplete
            ? { completedAt: new Date() }
            : definitionIsDriving
              ? {}
              : { completedAt: null }),
          // Clear the release claim in the same write that completes it
          ...(options?.ownedClaim && { releasingAt: null }),
          // Lock scope when leaving initial state on Driving lifecycles
          ...(shouldLockScope && {
            scopeLocked: true,
            scopeLockedAt: new Date(),
          }),
          // ...and reopen it when rework returns there
          ...(shouldUnlockScope && {
            scopeLocked: false,
            scopeLockedAt: null,
          }),
        })
        .where(
          and(
            eq(lifecycleInstances.id, instanceId),
            eq(lifecycleInstances.currentState, instance.currentState),
            // A release claim taken AFTER this transition read the instance
            // must still block it. Checking `releasingAt` only against the
            // entry snapshot left a window: a rework transition that began
            // before the claim could commit its state change while the merge
            // was running, so branches merged and closedAt was set while the
            // workflow landed somewhere non-final and the caller was told the
            // transition failed. Claim holders are exempt - they are the
            // release finishing its own work.
            ...(options?.ownedClaim
              ? []
              : [
                  or(
                    isNull(lifecycleInstances.releasingAt),
                    lt(
                      lifecycleInstances.releasingAt,
                      new Date(
                        Date.now() -
                          LifecycleInstanceService.RELEASE_CLAIM_TIMEOUT_MS,
                      ),
                    ),
                  ),
                ]),
          ),
        )
        .returning({ id: lifecycleInstances.id })

      if (casRows.length === 0) return false

      // Rework invalidates approvals (WI-4.1): when the target state can
      // reach the state we came from, the workflow will re-traverse that
      // segment, so votes on it are superseded — fresh approvals are
      // required the second time through. Runs only after the CAS write
      // wins, so a lost race never invalidates votes. Soft-invalidation
      // (supersededAt) keeps the votes for the audit trail (D7).
      const reachableFromTarget = this.collectReachableStates(
        effectiveStructure.transitions,
        toStateId,
      )
      if (reachableFromTarget.has(instance.currentState)) {
        const { ApprovalService } = await import('./ApprovalService')
        await ApprovalService.supersedeApprovalsForStates(
          instanceId,
          [toStateId, ...reachableFromTarget],
          tx,
        )
      }

      // Update the item's state to match (use state ID for consistency with service code)
      const updatedItem = (
        await tx
          .update(items)
          .set({
            state: toStateId,
            modifiedAt: new Date(),
            modifiedBy: actorId,
          })
          .where(eq(items.id, instance.itemId))
          .returning({
            itemType: items.itemType,
            masterId: items.masterId,
            designId: items.designId,
          })
      ).at(0)
      if (!updatedItem) {
        throw new NotFoundError('Item', instance.itemId, {
          operation: 'transition',
        })
      }

      await this.recordHistory(tx, {
        instanceId,
        fromState: instance.currentState,
        toState: toStateId,
        action: transition.name,
        actorId,
        comments,
        data: {
          guardResults,
          beforeActionResults: beforeResults,
          isInstanceLevel: effectiveStructure.isInstanceLevel,
        },
      })

      // The fact of the transition, in the transaction that writes it. The
      // history row is the de-facto transition log and the item row is what
      // every reader sees, so the event exists exactly when both do. It
      // precedes `afterFinalize` so a caller recording its own fact there —
      // a change order emitting `change_order.released` — orders after this
      // one, which is the order the change-order definitions describe.
      await publishDomainEvent(tx, LIFECYCLE_TRANSITIONED, {
        actorId,
        subject: { id: instance.itemId, masterId: updatedItem.masterId },
        context: {
          designId: updatedItem.designId ?? undefined,
          // An item outside any design — a change order — names the program
          // its linked designs share, when they share one.
          programId: updatedItem.designId
            ? undefined
            : ((await resolveChangeOrderProgram(tx, instance.itemId)) ??
              undefined),
        },
        payload: {
          instanceId,
          itemId: instance.itemId,
          itemType: updatedItem.itemType,
          fromState: instance.currentState,
          toState: toStateId,
          toStateIsFinal: isComplete,
          toStateFinalKind: targetStateObj?.finalKind ?? null,
          fromStateIsInitial: currentStateObj?.isInitial === true,
          toStateIsInitial: targetStateObj?.isInitial === true,
          action: transition.name,
          comments: comments ?? null,
        },
      })

      await options?.afterFinalize?.(tx)
      return true
    })

    if (!stateWritten) {
      return {
        success: false,
        fromState: instance.currentState,
        toState: toStateId,
        guardResults,
        error:
          'Concurrent transition detected: the workflow changed state while this transition was being processed',
      }
    }

    // Execute "after" actions (definition-level only)
    const afterResults: Array<ActionResult> = []
    if (!effectiveStructure.isInstanceLevel) {
      const workflowTransition = transition as LifecycleTransition
      const afterActions =
        workflowTransition.actions?.filter((a) => a.executeOn === 'after') || []

      for (const action of afterActions) {
        const result = await this.executeAction(
          action,
          { ...instance, currentState: toStateId },
          actorId,
          {
            fromStateId: instance.currentState,
            toStateId,
            states: effectiveStructure.states,
          },
        )
        afterResults.push(result)
        // Note: We don't fail the transition for after-action failures
      }
    }

    return {
      success: true,
      fromState: instance.currentState,
      toState: toStateId,
      guardResults,
      actionResults: [...beforeResults, ...afterResults],
    }
  }

  /**
   * The one writer of a transition's `workflow_history` row. Takes the
   * transition's transaction so the row commits with the state it records.
   * A seam on purpose: a test can make this write fail and prove that
   * nothing else of the transition lands either.
   */
  static async recordHistory(
    tx: TransactionClient,
    entry: typeof lifecycleHistory.$inferInsert,
  ): Promise<void> {
    await tx.insert(lifecycleHistory).values(entry)
  }

  /**
   * States reachable from `startId` by following transitions forward.
   * `startId` itself is included only when a cycle leads back to it.
   * Used to detect backward (rework) transitions: a transition is backward
   * when its target can reach its source again.
   */
  private static collectReachableStates(
    transitions: Array<{ fromStateId: string; toStateId: string }>,
    startId: string,
  ): Set<string> {
    const reachable = new Set<string>()
    // for-of visits elements appended mid-iteration, so this is a plain BFS
    const queue: Array<string> = [startId]
    for (const current of queue) {
      for (const transition of transitions) {
        if (transition.fromStateId !== current) continue
        if (!reachable.has(transition.toStateId)) {
          reachable.add(transition.toStateId)
          queue.push(transition.toStateId)
        }
      }
    }
    return reachable
  }

  /**
   * Execute a transition action
   */
  private static async executeAction(
    action: TransitionAction,
    instance: LifecycleInstance,
    actorId: string,
    flow: TransitionFlowContext,
  ): Promise<ActionResult> {
    try {
      switch (action.type) {
        case 'update_field':
          return await this.executeUpdateField(action, instance, actorId)

        case 'send_notification':
          return await this.executeSendNotification(
            action,
            instance,
            actorId,
            flow,
          )

        // Retired action types stored in raw JSONB (e.g. create_task) land
        // in the default arm and fail the action rather than the process
        default:
          return {
            actionId: action.id,
            actionName: action.name,
            success: false,
            error: `Unknown action type: ${action.type}`,
          }
      }
    } catch (error) {
      return {
        actionId: action.id,
        actionName: action.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Execute update_field action
   */
  private static async executeUpdateField(
    action: TransitionAction,
    instance: LifecycleInstance,
    _actorId: string,
  ): Promise<ActionResult> {
    const config = action.config as { fieldName?: string; value: unknown }

    // Runtime allowlist: definition-save validation also rejects this, but
    // raw-inserted definitions bypass it — never trust config here
    if (
      !config.fieldName ||
      !UPDATE_FIELD_ALLOWED_COLUMNS.has(config.fieldName)
    ) {
      return {
        actionId: action.id,
        actionName: action.name,
        success: false,
        error: `update_field may only write ${[...UPDATE_FIELD_ALLOWED_COLUMNS].join(', ')} — "${config.fieldName ?? '(missing fieldName)'}" is not allowed`,
      }
    }

    try {
      // For now, only support updating item-level fields
      await db
        .update(items)
        .set({
          [config.fieldName]: config.value,
        })
        .where(eq(items.id, instance.itemId))

      return { actionId: action.id, actionName: action.name, success: true }
    } catch (error) {
      return {
        actionId: action.id,
        actionName: action.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * Execute send_notification action
   * Resolves recipients (users or roles), filters by permission, and submits notification job
   */
  private static async executeSendNotification(
    action: TransitionAction,
    instance: LifecycleInstance,
    actorId: string,
    flow: TransitionFlowContext,
  ): Promise<ActionResult> {
    const { UserService } = await import('../auth/UserService')
    const { AccessControlService } =
      await import('../auth/AccessControlService')
    const { JobService } = await import('../jobs/JobService')

    try {
      const config = action.config as SendNotificationConfig
      if (config.recipients.length === 0) {
        // No recipients configured, skip silently
        return { actionId: action.id, actionName: action.name, success: true }
      }

      // Get item details
      const item = await this.getItemData(instance.itemId)
      if (!item) {
        return {
          actionId: action.id,
          actionName: action.name,
          success: false,
          error: 'Item not found',
        }
      }

      // Get actor details
      const actor = await UserService.getUserById(actorId)
      if (!actor) {
        return {
          actionId: action.id,
          actionName: action.name,
          success: false,
          error: 'Actor not found',
        }
      }

      // Resolve recipients from config
      const recipientUserIds = new Set<string>()
      for (const recipient of config.recipients) {
        if (recipient.type === 'user') {
          if (recipient.id) {
            recipientUserIds.add(recipient.id)
          }
        } else {
          // Get all users with this role
          const usersWithRole = await UserService.listUsers({
            roleId: recipient.id,
          })
          for (const user of usersWithRole) {
            if (user.active) {
              recipientUserIds.add(user.id)
            }
          }
        }
      }

      if (recipientUserIds.size === 0) {
        // No recipients resolved, skip silently
        return { actionId: action.id, actionName: action.name, success: true }
      }

      // Filter recipients by permission (if item has designId)
      const designId = item.designId as string | undefined
      const filteredUserIds: Array<string> = []

      for (const userId of recipientUserIds) {
        // Skip the actor (they already know about the transition)
        if (userId === actorId) continue

        // Check if user can access the design (if applicable)
        if (designId) {
          const canAccess = await AccessControlService.canAccessDesign(
            userId,
            designId,
          )
          if (!canAccess) continue
        }

        filteredUserIds.push(userId)
      }

      if (filteredUserIds.length === 0) {
        // No recipients after filtering, skip silently
        return { actionId: action.id, actionName: action.name, success: true }
      }

      // Get full user details for recipients
      const recipientDetails: Array<{
        userId: string
        email: string
        name: string
      }> = []
      for (const userId of filteredUserIds) {
        const user = await UserService.getUserById(userId)
        if (user && user.email) {
          recipientDetails.push({
            userId: user.id,
            email: user.email,
            name: user.name || user.email,
          })
        }
      }

      if (recipientDetails.length === 0) {
        return { actionId: action.id, actionName: action.name, success: true }
      }

      // The in-flight transition's states are passed in explicitly — for
      // "before" actions the history still holds the *previous* transition,
      // so it must never be consulted for from/to here
      const fromStateName =
        flow.states.find((s) => s.id === flow.fromStateId)?.name ??
        flow.fromStateId
      const toStateName =
        flow.states.find((s) => s.id === flow.toStateId)?.name ?? flow.toStateId

      // Submit notification job
      await JobService.submit(
        'notification.workflow.transition',
        {
          itemId: instance.itemId,
          itemNumber: (item.itemNumber as string) || 'Unknown',
          itemType: (item.itemType as string) || 'Item',
          fromState: fromStateName || 'Unknown',
          toState: toStateName || 'Unknown',
          transitionName: action.name,
          actorId,
          actorName: actor.name || actor.email,
          actorEmail: actor.email,
          recipients: recipientDetails,
          changeOrderNumber: (item.itemNumber as string) || undefined,
        },
        actorId,
        { itemId: instance.itemId },
      )

      return {
        actionId: action.id,
        actionName: action.name,
        success: true,
        data: { recipientCount: recipientDetails.length },
      }
    } catch (error) {
      return {
        actionId: action.id,
        actionName: action.name,
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  /**
   * The context guards are evaluated against, built the same way for the
   * preview and for execution: the item the instance runs on, loaded here
   * rather than trusted from the caller, and the actor's roles, resolved
   * here unless the caller already has them. A caller that supplies an item
   * keeps it — tests hand in shaped items on purpose — but nothing outside
   * this class has to know what a guard reads.
   */
  private static async buildGuardContext(
    instance: LifecycleInstance,
    input: GuardContextInput,
  ): Promise<GuardContext> {
    const item = input.item ?? (await this.getItemData(instance.itemId)) ?? {}
    const roles =
      input.user.roles ?? (await permissionService.getUserRoles(input.user.id))
    return {
      item,
      user: { id: input.user.id, roles },
      workflowInstance: input.workflowInstance ?? instance,
    }
  }

  /**
   * Get item data for guard evaluation
   */
  private static async getItemData(
    itemId: string,
  ): Promise<Record<string, unknown> | null> {
    const { ItemService } = await import('../items/services/ItemService')
    const item = await ItemService.findById(itemId)
    return item as Record<string, unknown> | null
  }

  // ============================================
  // Free-lifecycle items
  // ============================================

  /**
   * Transition a Free-lifecycle item (Issue, Tool, ...) to a new state.
   *
   * This is the only sanctioned write path for Free-lifecycle item state:
   * the generic item update rejects state changes (WI-2.1), Driven items
   * change state at ECO release, and change orders go through their own
   * workflow endpoint. Lazily creates a workflow instance for the item (D6)
   * and delegates to this.transition(), so transition validation,
   * guards, approvals, history, and the Phase 1 hardening all apply.
   *
   * Accepts the target state by id or display name.
   *
   * Goal-idempotent, deliberately: the operation names a target STATE, not a
   * particular edge. When the item already sits in the target state — because
   * it always did, or because a concurrent caller made exactly this move while
   * this one was reading — the call succeeds as a no-op with zero writes
   * rather than raising a ValidationError the caller can do nothing about.
   * Only the eligibility rules above (unknown state, released lineage, change
   * orders, an unfinished work-order traveler) reject, and they run before
   * the idempotent return. A lost race that landed somewhere ELSE still
   * fails, and absorption is keyed on the instance's observed state, never
   * on an error message.
   */
  static async transitionFreeItem(
    itemId: string,
    toState: string,
    userId: string,
    comments?: string,
  ): Promise<{ fromStateId: string; toStateId: string; toStateName: string }> {
    const { ItemService } = await import('../items/services/ItemService')

    const item = await ItemService.findById(itemId)
    if (!item) {
      throw new NotFoundError('Item', itemId)
    }

    if (item.itemType === 'ChangeOrder') {
      throw new ValidationError(
        'Change orders transition through their workflow endpoint, not the item transition endpoint',
      )
    }

    const lifecycle = await ItemTypeRegistry.getLifecycleForType(item.itemType)
    if (!lifecycle) {
      throw new ValidationError(
        `Item type "${item.itemType}" has no lifecycle assigned; its state cannot be transitioned`,
      )
    }

    // Input tolerance at the API boundary only: callers may name the target
    // by ID or display name, and it resolves to the ID immediately — every
    // comparison and write below uses targetState.id
    const states = lifecycle.states
    const targetState = states.find(
      (s) => s.id === toState || s.name === toState,
    )
    if (!targetState) {
      throw new ValidationError(
        `Unknown state "${toState}" for ${item.itemType}`,
      )
    }

    // A Driven lifecycle may declare manual transitions among its
    // pre-release states (review progress: Draft → Proposed → Approved). What
    // it may never do manually is enter or leave released lineage — those
    // states are entered only by a change-order release, and once there the
    // version is immutable. Derived from the mappings, never from a name.
    if (resolveLifecycleType(lifecycle) === 'Driven') {
      const family = await LifecycleService.getReleasedFamilyStates(
        item.itemType,
      )
      if (family.includes(targetState.id)) {
        throw new ValidationError(
          `${item.itemType} enters "${targetState.name}" only through a change-order release: add the item to a change order instead of transitioning it directly`,
        )
      }
      if (item.state && family.includes(item.state)) {
        throw new ValidationError(
          `${item.itemType} is released lineage in "${item.state}" and cannot be transitioned directly; revise it through a change order`,
        )
      }
    }

    // Work orders carry completion semantics no other Free type has, and
    // both halves live here rather than in the caller: the traveler gates
    // entry into a `finalKind: 'complete'` state, and completedAt is stamped
    // on the way in. Held as an unconditional arm beside the ChangeOrder one
    // — a registry would let this vanish for any caller that had not
    // imported the registration, which is the shape of the defect it would
    // be guarding. Read off the resolved target's own flags — the
    // same pair getFinalKind derives from — so a caller naming the state
    // rather than its id is gated identically, and there is no second
    // lookup to fall out of step with the transition's.
    const completing =
      item.itemType === 'WorkOrder' &&
      targetState.isFinal === true &&
      targetState.finalKind === 'complete'
    if (completing) {
      const { WorkOrderInstructionService } =
        await import('../services/WorkOrderInstructionService')
      await WorkOrderInstructionService.assertReadyForCompletion(itemId)
    }

    // Every success path reports through here, so no one of them can return
    // an order that reached a complete state without its stamp. Entering the
    // state stamps it; re-asserting a goal the order already holds writes
    // only to repair a stamp that is missing, never to slide the completion
    // time of a record that is already closed. completedAt is a work_orders
    // type field, not lifecycle-controlled, which is why it is its own write.
    const settle = async (fromStateId: string, alreadyThere = false) => {
      const stamped = (item as { completedAt?: Date | null }).completedAt
      if (completing && !(alreadyThere && stamped)) {
        await ItemService.update(
          itemId,
          { completedAt: new Date() } as never,
          userId,
        )
      }
      return {
        fromStateId,
        toStateId: targetState.id,
        toStateName: targetState.name,
      }
    }

    // Lazily create the instance: Free-lifecycle items get the workflow
    // machinery on their first transition
    let instance = await this.getInstanceByItemId(itemId)
    if (!instance) {
      try {
        instance = await this.startInstance(lifecycle.id, itemId, {
          actorId: userId,
        })
      } catch (error) {
        // `workflow_instances_one_active_per_item` makes the loser of a
        // concurrent lazy create fail. Adopt the winner's instance and carry
        // on — the PhysicalPartService.register shape. Matched on error
        // class, never on a message.
        if (!(error instanceof AlreadyExistsError)) throw error
        instance = await this.getInstanceByItemId(itemId)
        if (!instance) throw error
      }
    }

    // The goal already holds: another writer put the item where this call
    // wanted it (or it never left). Return success without moving it — and
    // before the adopt below, which would otherwise roll the instance
    // BACKWARD onto this caller's stale item read and record a
    // `state_adopted` regression that never happened.
    if (instance.currentState === targetState.id) {
      return settle(instance.currentState, true)
    }

    // Adopt the item's stored state if the instance diverges (items whose
    // state was written before this endpoint existed start out of sync).
    // Stored state is an ID (WI-5.2 normalized the data) — no name fallback.
    const currentState = states.find((s) => s.id === item.state)
    if (currentState && instance.currentState !== currentState.id) {
      await this.adoptInstanceState(instance.id, currentState.id, userId)
      instance = { ...instance, currentState: currentState.id }
    }

    const result = await this.transition(
      instance.id,
      targetState.id,
      userId,
      comments,
    )
    if (!result.success) {
      // A concurrent writer may have made exactly this move between the read
      // above and the compare-and-swap inside transition(). Ask the instance
      // where it actually is rather than parsing why the attempt failed: if
      // it is in the target state, the goal is met and this call succeeded;
      // anything else is a genuine rejection and still throws.
      const settled = await this.getInstance(instance.id)
      if (settled && settled.currentState === targetState.id) {
        return settle(result.fromState)
      }
      throw new ValidationError(result.error || 'Transition not allowed')
    }

    return settle(result.fromState)
  }

  /**
   * List the manual transitions available to an item from its current state:
   * every transition its Free lifecycle declares, or — for a Driven
   * lifecycle — the declared pre-release edges (review progress), never one
   * into released lineage, and nothing at all once the item is released
   * lineage. Read-only — does not create a workflow instance, and guards are
   * evaluated on the actual transition, so this is a UI hint, not a promise.
   * Empty (with the lifecycleType) when there is nothing to offer, so the UI
   * can hide the control.
   */
  static async getAvailableFreeTransitions(itemId: string): Promise<{
    lifecycleType: LifecycleType | null
    currentStateId: string | null
    transitions: Array<{
      id: string
      name: string
      toStateId: string
      toStateName: string
      toStateColor?: string
      /** Whether the target ends the flow, and what that means there */
      toStateIsFinal: boolean
      toStateFinalKind: FinalKind | null
    }>
  }> {
    const { ItemService } = await import('../items/services/ItemService')

    const item = await ItemService.findById(itemId)
    if (!item) {
      throw new NotFoundError('Item', itemId)
    }

    const lifecycle = await ItemTypeRegistry.getLifecycleForType(item.itemType)
    if (!lifecycle) {
      return { lifecycleType: null, currentStateId: null, transitions: [] }
    }

    const lifecycleType = resolveLifecycleType(lifecycle)
    if (lifecycleType === 'Driving') {
      return { lifecycleType, currentStateId: null, transitions: [] }
    }

    // Stored state is an ID (WI-5.2) — no name fallback
    const states = lifecycle.states
    const currentState = states.find((s) => s.id === item.state)
    if (!currentState) {
      return { lifecycleType, currentStateId: null, transitions: [] }
    }

    // Released lineage is entered and left only by change-order release
    const family =
      lifecycleType === 'Driven'
        ? await LifecycleService.getReleasedFamilyStates(item.itemType)
        : []
    if (family.includes(currentState.id)) {
      return { lifecycleType, currentStateId: currentState.id, transitions: [] }
    }

    const transitions = (lifecycle.transitions ?? [])
      .filter(
        (t) =>
          t.fromStateId === currentState.id && !family.includes(t.toStateId),
      )
      .map((t) => {
        const target = states.find((s) => s.id === t.toStateId)
        return {
          id: t.id,
          name: t.name,
          toStateId: t.toStateId,
          toStateName: target?.name ?? t.toStateId,
          toStateColor: target?.color,
          toStateIsFinal: target?.isFinal ?? false,
          toStateFinalKind: target?.isFinal ? (target.finalKind ?? null) : null,
        }
      })

    return { lifecycleType, currentStateId: currentState.id, transitions }
  }
}
