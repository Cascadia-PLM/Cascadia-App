// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Service for lifecycle-specific operations.
 *
 * Unified Lifecycle Model:
 * - Free lifecycles: Self-controlled with manual transitions (Programs, Projects, Designs)
 * - Driven lifecycles: ECO-controlled, declares states only (Parts, Documents, Requirements)
 * - Driving lifecycles: Controls Driven lifecycles via TransitionDrivenItem actions (Change Orders)
 *
 * Legacy Support:
 * Also handles changeActionMappings for backward compatibility with existing lifecycles.
 */

import { eq } from 'drizzle-orm'
import { db } from '../db'
import { workflowDefinitions } from '../db/schema/workflows'
import { ItemTypeRegistry } from '../items/registry'
import { NotFoundError, ValidationError } from '../errors'
import {
  resolveLifecycleType,
  resolveStoredLifecycleType,
} from '../workflows/normalize'
import { RevisionService } from './RevisionService'
import type {
  ActionValidationResult,
  ChangeAction,
  ChangeActionMappings,
  LifecyclePhaseConfig,
  PromoteActionMapping,
  ReviseActionMapping,
  RevisionScheme,
  StateChangeActionMapping,
} from '../types/lifecycle'
import type {
  LifecycleType,
  WorkflowDefinition,
  WorkflowState,
} from '../workflows/types'
import { serviceLogger } from '@/lib/logging/logger'

/**
 * The states and revision scheme a release needs for one item type.
 * Every value is resolved from the lifecycle, with the historical fallbacks
 * applied for types that have none configured.
 */
export interface ResolvedActionStates {
  releaseState: string
  obsoleteState: string
  /** `revise.newVersionState` — what a NEW revision enters */
  reviseState: string
  /** `revise.oldVersionState` — what the version it replaces becomes */
  supersededState: string | null
  revisionScheme?: RevisionScheme
}

/**
 * Lifecycle with resolved change action mappings
 */
export interface ResolvedLifecycle {
  id: string
  name: string
  states: Array<WorkflowState>
  changeActionMappings: ChangeActionMappings
  revisionScheme?: RevisionScheme
  phases?: Array<LifecyclePhaseConfig>
}

export class LifecycleService {
  /**
   * Get lifecycle definition for an item type with resolved changeActionMappings.
   * Returns null if no lifecycle is assigned or changeActionMappings are not configured.
   */
  static async getLifecycleForItemType(
    itemType: string,
  ): Promise<ResolvedLifecycle | null> {
    const lifecycle = await ItemTypeRegistry.getLifecycleForType(itemType)

    if (!lifecycle) {
      return null
    }

    // Ensure changeActionMappings exist
    if (!lifecycle.changeActionMappings) {
      serviceLogger.warn(
        { lifecycle: lifecycle.name, itemType },
        'Lifecycle has no changeActionMappings configured',
      )
      return null
    }

    return {
      id: lifecycle.id,
      name: lifecycle.name,
      states: lifecycle.states,
      changeActionMappings: lifecycle.changeActionMappings,
      revisionScheme: (lifecycle as any).revisionScheme,
      phases: (lifecycle as any).phases,
    }
  }

  /**
   * Get the revision scheme for an item type.
   * Returns the lifecycle-level revision scheme, or undefined for alpha fallback.
   */
  static async getRevisionScheme(
    itemType: string,
  ): Promise<RevisionScheme | undefined> {
    const lifecycle = await this.getLifecycleForItemType(itemType)
    return lifecycle?.revisionScheme
  }

  /**
   * Get the state transition mapping for a specific change action.
   * Returns null if the action is not configured or lifecycle is not found.
   */
  static async getActionMapping(
    itemType: string,
    action: ChangeAction,
  ): Promise<
    StateChangeActionMapping | ReviseActionMapping | PromoteActionMapping | null
  > {
    const lifecycle = await this.getLifecycleForItemType(itemType)
    if (!lifecycle) {
      return null
    }

    return lifecycle.changeActionMappings[action] ?? null
  }

  /**
   * Validate that a change action can be applied to an item in its current state.
   *
   * @param itemType - The type of item (Part, Document, etc.)
   * @param currentState - The item's current lifecycle state
   * @param action - The change action to validate
   * @returns Validation result with error message if invalid
   */
  static async canApplyAction(
    itemType: string,
    currentState: string,
    action: ChangeAction,
    options?: {
      /**
       * The Driving lifecycle attempting the action (the ECO's workflow
       * definition ID). When set, it must be authorized by the Driven
       * lifecycle's `drivers` allow-list — an empty list stays permissive.
       */
      drivingLifecycleId?: string
    },
  ): Promise<ActionValidationResult> {
    const lifecycle = await this.getLifecycleForItemType(itemType)
    if (!lifecycle) {
      return {
        valid: false,
        error: `Action "${action}" is not configured for ${itemType} lifecycle`,
      }
    }

    if (options?.drivingLifecycleId) {
      const driverAllowed = await this.canDriverActOnLifecycle(
        options.drivingLifecycleId,
        lifecycle.id,
      )
      if (!driverAllowed) {
        return {
          valid: false,
          error: `This change order's workflow is not an authorized driver of the ${itemType} lifecycle ("${lifecycle.name}")`,
        }
      }
    }

    const mapping = lifecycle.changeActionMappings[action] ?? null

    if (!mapping) {
      return {
        valid: false,
        error: `Action "${action}" is not configured for ${itemType} lifecycle`,
      }
    }

    if (mapping.fromState !== currentState) {
      return {
        valid: false,
        error: `Cannot apply "${action}" to item in "${currentState}" state. Required state: "${mapping.fromState}"`,
      }
    }

    // For promote, validate that it crosses a phase boundary
    if (action === 'promote') {
      if (lifecycle.phases && lifecycle.phases.length > 0) {
        const promoteMapping = mapping as PromoteActionMapping
        const crossing = this.crossesPhase(
          lifecycle,
          promoteMapping.fromState,
          promoteMapping.toState,
        )
        if (!crossing.crosses) {
          return {
            valid: false,
            error: `Promote action must cross a phase boundary. Both states are in the same phase.`,
          }
        }
      }
    }

    return { valid: true }
  }

  /**
   * Get all valid change actions for an item in a given state.
   * Returns actions that can be applied based on the lifecycle's changeActionMappings.
   *
   * @param itemType - The type of item (Part, Document, etc.)
   * @param currentState - The item's current lifecycle state
   * @returns Array of valid change actions
   */
  static async getValidActions(
    itemType: string,
    currentState: string,
  ): Promise<Array<ChangeAction>> {
    const validActions: Array<ChangeAction> = []

    const lifecycle = await this.getLifecycleForItemType(itemType)
    if (!lifecycle) {
      return validActions
    }

    const mappings = lifecycle.changeActionMappings

    // Check each state-changing action
    if (mappings.release?.fromState === currentState) {
      validActions.push('release')
    }
    if (mappings.revise?.fromState === currentState) {
      validActions.push('revise')
    }
    if (mappings.obsolete?.fromState === currentState) {
      validActions.push('obsolete')
    }
    if (mappings.promote?.fromState === currentState) {
      validActions.push('promote')
    }

    return validActions
  }

  /**
   * Get the target state for a change action.
   * For revise, returns the newVersionState.
   *
   * @param itemType - The type of item
   * @param action - The change action
   * @returns The target state name, or null if action is not configured
   */
  static async getTargetState(
    itemType: string,
    action: ChangeAction,
  ): Promise<string | null> {
    const mapping = await this.getActionMapping(itemType, action)
    if (!mapping) {
      return null
    }

    if (action === 'revise') {
      return (mapping as ReviseActionMapping).newVersionState
    }

    if (action === 'promote') {
      return (mapping as PromoteActionMapping).toState
    }

    return (mapping as StateChangeActionMapping).toState
  }

  /**
   * What a change action will do to an item: the state it enters and the
   * revision it will carry there.
   *
   * The single authority for this prediction. It used to be computed in three
   * places that disagreed — `addAffectedItem` (promote only),
   * `ChangeOrderMergeService.resolvePromote`, and a client-side
   * `eco-helpers.getTargetInfo` that returned `[` for an item at revision Z
   * and had never heard of the numeric or prefixed-numeric schemes. The
   * client's answer was the one that reached the database.
   *
   * `revision` is a **prediction**, not a promise: for `revise` the merge
   * recomputes it against main's current version at release time, because
   * another change order may have released a newer revision in between. Use
   * it to show the user what to expect, never as the value to release.
   *
   * Returns null for an action the lifecycle does not configure.
   */
  static async resolveActionTarget(
    itemType: string,
    action: ChangeAction,
    currentRevision: string,
  ): Promise<{
    toState: string
    revision: string
    assignsRevision: boolean
  } | null> {
    const lifecycle = await this.getLifecycleForItemType(itemType)
    const mapping = lifecycle?.changeActionMappings[action] ?? null
    if (!lifecycle || !mapping) {
      return null
    }

    const toState =
      action === 'revise'
        ? (mapping as ReviseActionMapping).newVersionState
        : (mapping as StateChangeActionMapping | PromoteActionMapping).toState

    // Promote is the only action whose scheme can differ from the lifecycle
    // default: the target phase may override it and may reset numbering.
    if (action === 'promote') {
      const promoteMapping = mapping as PromoteActionMapping
      const scheme = this.getRevisionSchemeForState(lifecycle, toState)

      let shouldReset = promoteMapping.resetRevision
      if (shouldReset === undefined) {
        shouldReset = this.getPhaseForState(
          lifecycle,
          toState,
        )?.resetRevisionOnEntry
      }

      let revision = currentRevision
      if (shouldReset) {
        revision = RevisionService.getInitialRevision(scheme)
      } else if (promoteMapping.assignsRevision) {
        revision = RevisionService.getNextRevision(currentRevision, scheme)
      }

      return {
        toState,
        revision,
        assignsRevision: Boolean(promoteMapping.assignsRevision || shouldReset),
      }
    }

    const scheme = lifecycle.revisionScheme

    if (!mapping.assignsRevision) {
      // obsolete: the item keeps whatever revision it already carries
      return { toState, revision: currentRevision, assignsRevision: false }
    }

    // A first release gives the scheme's initial revision to a version that
    // never carried one; a revision that already exists is left alone.
    const revision =
      action === 'release'
        ? RevisionService.isWorkingRevision(currentRevision)
          ? RevisionService.getInitialRevision(scheme)
          : currentRevision
        : RevisionService.getNextRevision(currentRevision, scheme)

    return { toState, revision, assignsRevision: true }
  }

  /**
   * Every state a release path needs for one item type, resolved once.
   *
   * The merge asks the same five questions in five places — the branch path,
   * the branchless affected-items path, the post-branch pass, and twice more
   * inside `revise` — each with its own `|| 'Released'` / `|| 'Obsolete'` /
   * `|| 'Superseded'` fallback. There were nine such fallbacks, and every one
   * was an opportunity for the paths to drift apart; two of them had already
   * done so, which is what the supersession and revise-state fixes were about.
   *
   * The fallbacks are what an item type with no configured lifecycle gets. They
   * live here now, once.
   */
  static async resolveActionStates(
    itemType: string,
  ): Promise<ResolvedActionStates> {
    const releaseState =
      (await this.getTargetState(itemType, 'release')) ?? 'Released'

    return {
      releaseState,
      obsoleteState:
        (await this.getTargetState(itemType, 'obsolete')) ?? 'Obsolete',
      // A branch merge of a modified item IS a revise, so it follows the revise
      // mapping: the new version enters newVersionState and the version it
      // replaces becomes oldVersionState. Stamping the release state here
      // instead left every superseded row still reading 'Released',
      // distinguishable only by isCurrent.
      reviseState:
        (await this.getTargetState(itemType, 'revise')) ?? releaseState,
      supersededState: await this.getOldVersionState(itemType),
      revisionScheme: await this.getRevisionScheme(itemType),
    }
  }

  /**
   * Check if a change action assigns a revision letter.
   *
   * @param itemType - The type of item
   * @param action - The change action
   * @returns true if the action assigns a revision, false otherwise
   */
  static async assignsRevision(
    itemType: string,
    action: ChangeAction,
  ): Promise<boolean> {
    const mapping = await this.getActionMapping(itemType, action)
    if (!mapping) {
      return false
    }

    return mapping.assignsRevision
  }

  /**
   * Get the old version state for a revise action.
   * Only applicable for 'revise' action.
   *
   * @param itemType - The type of item
   * @returns The old version state, or null if revise is not configured
   */
  static async getOldVersionState(itemType: string): Promise<string | null> {
    const mapping = await this.getActionMapping(itemType, 'revise')
    if (!mapping) {
      return null
    }

    return (mapping as ReviseActionMapping).oldVersionState
  }

  /**
   * Get the initial state ID for a new item of this type.
   * Returns the ID of the state marked isInitial in the lifecycle
   * definition. State identity is IDs everywhere (WI-5.1) — names exist
   * for display only.
   *
   * @param itemType - The type of item
   * @returns The initial state ID, or 'Draft' as fallback
   */
  static async getInitialStateId(itemType: string): Promise<string> {
    const lifecycle = await ItemTypeRegistry.getLifecycleForType(itemType)

    if (lifecycle) {
      const initialState = lifecycle.states.find((s) => s.isInitial)
      if (initialState) {
        return initialState.id
      }
    }

    // Fallback
    return 'Draft'
  }

  // ============================================
  // Phase Resolution Methods
  // ============================================

  /**
   * Get the phase configuration for a state in a lifecycle.
   * Uses the state's phaseId to look up the phase definition.
   */
  static getPhaseForState(
    lifecycle: ResolvedLifecycle | WorkflowDefinition,
    stateId: string,
  ): LifecyclePhaseConfig | undefined {
    const phases = lifecycle.phases
    if (!phases || phases.length === 0) return undefined

    // State identity is IDs (WI-5.1); the former name fallback is gone
    const states = lifecycle.states
    const state = states.find((s) => s.id === stateId)
    if (!state?.phaseId) return undefined

    return phases.find((p) => p.id === state.phaseId)
  }

  /**
   * Get the effective revision scheme for a state.
   * Resolution order: phase override > lifecycle default > undefined (alpha fallback)
   */
  static getRevisionSchemeForState(
    lifecycle: ResolvedLifecycle | WorkflowDefinition,
    stateId: string,
  ): RevisionScheme | undefined {
    // Check phase-level override
    const phase = this.getPhaseForState(lifecycle, stateId)
    if (phase?.revisionScheme) {
      return phase.revisionScheme
    }

    // Fall back to lifecycle-level scheme
    return lifecycle.revisionScheme
  }

  /**
   * Check whether a transition crosses a phase boundary.
   * Returns info about the from/to phases if they differ.
   */
  static crossesPhase(
    lifecycle: ResolvedLifecycle | WorkflowDefinition,
    fromStateId: string,
    toStateId: string,
  ): {
    crosses: boolean
    fromPhase?: LifecyclePhaseConfig
    toPhase?: LifecyclePhaseConfig
  } {
    const fromPhase = this.getPhaseForState(lifecycle, fromStateId)
    const toPhase = this.getPhaseForState(lifecycle, toStateId)

    // If either state has no phase, no crossing
    if (!fromPhase || !toPhase) {
      return { crosses: false, fromPhase, toPhase }
    }

    return {
      crosses: fromPhase.id !== toPhase.id,
      fromPhase,
      toPhase,
    }
  }

  // ============================================
  // Unified Lifecycle Model Methods
  // ============================================

  /**
   * Get the lifecycle type for an item type.
   * Returns the lifecycleType from the assigned lifecycle definition.
   *
   * @param itemType - The type of item (Part, Document, etc.)
   * @returns The lifecycle type (Free, Driven, Driving), or 'Free' as fallback
   */
  static async getLifecycleType(itemType: string): Promise<LifecycleType> {
    const lifecycle = await ItemTypeRegistry.getLifecycleForType(itemType)
    if (!lifecycle) {
      return 'Free'
    }
    return resolveLifecycleType(lifecycle)
  }

  /**
   * Get the IDs of Driving lifecycles that can act on a Driven lifecycle.
   *
   * @param lifecycleId - The ID of the Driven lifecycle
   * @returns Array of Driving lifecycle IDs, or empty array if none configured
   */
  static async getDrivers(lifecycleId: string): Promise<Array<string>> {
    const result = await db
      .select({
        drivers: workflowDefinitions.drivers,
      })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, lifecycleId))
      .limit(1)

    const row = result.at(0)
    return row?.drivers ?? []
  }

  /**
   * Check if a Driving lifecycle can act on a Driven lifecycle.
   *
   * @param drivingId - The ID of the Driving lifecycle (e.g., ECO workflow)
   * @param drivenId - The ID of the Driven lifecycle (e.g., Parts lifecycle)
   * @returns true if the driver is allowed, false otherwise
   */
  static async canDriverActOnLifecycle(
    drivingId: string,
    drivenId: string,
  ): Promise<boolean> {
    const drivers = await this.getDrivers(drivenId)

    // If no drivers are configured, any Driving lifecycle can act (permissive default)
    if (drivers.length === 0) {
      return true
    }

    return drivers.includes(drivingId)
  }

  /**
   * Get the lifecycle definition by ID.
   *
   * @param lifecycleId - The ID of the lifecycle
   * @returns The lifecycle definition, or null if not found
   */
  static async getLifecycleById(lifecycleId: string): Promise<{
    id: string
    name: string
    lifecycleType: LifecycleType
    states: Array<WorkflowState>
    drivers: Array<string>
  } | null> {
    const result = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, lifecycleId))
      .limit(1)

    const row = result.at(0)
    if (!row) {
      return null
    }

    const def = row.definition as {
      states?: Array<WorkflowState>
      definitionType?: string
      lifecycleType?: LifecycleType
    }

    // JSONB speaks first; the column only when the JSONB is silent — its
    // ADD-COLUMN default lied about legacy rows (normalize.ts has the rule)
    const lifecycleType = resolveStoredLifecycleType(row.lifecycleType, def)

    return {
      id: row.id,
      name: row.name,
      lifecycleType,
      states: def.states ?? [],
      drivers: row.drivers ?? [],
    }
  }

  // ============================================
  // Free-Lifecycle Transitions (remediation WI-2.2)
  // ============================================

  /**
   * Transition a Free-lifecycle item (Issue, Tool, ...) to a new state.
   *
   * This is the only sanctioned write path for Free-lifecycle item state:
   * the generic item update rejects state changes (WI-2.1), Driven items
   * change state at ECO release, and change orders go through their own
   * workflow endpoint. Lazily creates a workflow instance for the item (D6)
   * and delegates to WorkflowService.transition(), so transition validation,
   * guards, approvals, history, and the Phase 1 hardening all apply.
   *
   * Accepts the target state by id or display name.
   */
  static async transitionFreeItem(
    itemId: string,
    toState: string,
    userId: string,
    comments?: string,
  ): Promise<{ fromStateId: string; toStateId: string; toStateName: string }> {
    const { ItemService } = await import('../items/services/ItemService')
    const { WorkflowService } = await import('../workflows/WorkflowService')

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

    if (resolveLifecycleType(lifecycle) !== 'Free') {
      throw new ValidationError(
        `${item.itemType} states are ECO-controlled: add the item to a change order instead of transitioning it directly`,
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

    // Lazily create the instance: Free-lifecycle items get the workflow
    // machinery on their first transition
    let instance = await WorkflowService.getInstanceByItemId(itemId)
    if (!instance) {
      instance = await WorkflowService.startInstance(lifecycle.id, itemId, {
        actorId: userId,
      })
    }

    // Adopt the item's stored state if the instance diverges (items whose
    // state was written before this endpoint existed start out of sync).
    // Stored state is an ID (WI-5.2 normalized the data) — no name fallback.
    const currentState = states.find((s) => s.id === item.state)
    if (currentState && instance.currentState !== currentState.id) {
      await WorkflowService.adoptInstanceState(
        instance.id,
        currentState.id,
        userId,
      )
      instance = { ...instance, currentState: currentState.id }
    }

    const result = await WorkflowService.transition(
      instance.id,
      targetState.id,
      userId,
      comments,
    )
    if (!result.success) {
      throw new ValidationError(result.error || 'Transition not allowed')
    }

    return {
      fromStateId: result.fromState,
      toStateId: targetState.id,
      toStateName: targetState.name,
    }
  }

  /**
   * List the transitions available to a Free-lifecycle item from its current
   * state. Read-only — does not create a workflow instance, and guards are
   * evaluated on the actual transition, so this is a UI hint, not a promise.
   * Returns an empty list (with the lifecycleType) for non-Free items so the
   * UI can hide the control.
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
    if (lifecycleType !== 'Free') {
      return { lifecycleType, currentStateId: null, transitions: [] }
    }

    // Stored state is an ID (WI-5.2) — no name fallback
    const states = lifecycle.states
    const currentState = states.find((s) => s.id === item.state)
    if (!currentState) {
      return { lifecycleType, currentStateId: null, transitions: [] }
    }

    const transitions = (lifecycle.transitions ?? [])
      .filter((t) => t.fromStateId === currentState.id)
      .map((t) => {
        const target = states.find((s) => s.id === t.toStateId)
        return {
          id: t.id,
          name: t.name,
          toStateId: t.toStateId,
          toStateName: target?.name ?? t.toStateId,
          toStateColor: target?.color,
        }
      })

    return { lifecycleType, currentStateId: currentState.id, transitions }
  }
}
