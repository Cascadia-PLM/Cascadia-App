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
import {
  AlreadyExistsError,
  InternalError,
  NotFoundError,
  ValidationError,
} from '../errors'
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
  FinalKind,
  LifecycleType,
  WorkflowDefinition,
  WorkflowState,
  WorkflowTransition,
} from '../workflows/types'
import { serviceLogger } from '@/lib/logging/logger'

/**
 * The states and revision scheme a release needs for one item type.
 * Every value comes from the lifecycle's change-action mappings; `null`
 * means the lifecycle defines no such action (Free lifecycles define none).
 */
export interface ResolvedActionStates {
  releaseState: string | null
  obsoleteState: string | null
  /** `revise.newVersionState` — what a NEW revision enters */
  reviseState: string | null
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
  transitions?: Array<WorkflowTransition>
  changeActionMappings: ChangeActionMappings
  revisionScheme?: RevisionScheme
  phases?: Array<LifecyclePhaseConfig>
}

export class LifecycleService {
  /**
   * Get the lifecycle definition for an item type. Returns null only when no
   * lifecycle is assigned.
   *
   * Missing changeActionMappings are NOT a reason to return null: Free
   * lifecycles legitimately define none — their items are not
   * ECO-controlled — and the flag predicates (isInitialState, getFinalKind,
   * getFinalStateIds) and transition machinery must still see their states.
   * This used to null-out on missing mappings, which silently blinded every
   * consumer to Free lifecycles.
   */
  static async getLifecycleForItemType(
    itemType: string,
  ): Promise<ResolvedLifecycle | null> {
    const lifecycle = await ItemTypeRegistry.getLifecycleForType(itemType)

    if (!lifecycle) {
      return null
    }

    if (
      !lifecycle.changeActionMappings &&
      lifecycle.lifecycleType === 'Driven'
    ) {
      // A Driven lifecycle without mappings IS misconfigured — the merge
      // would have nothing to apply. Surface it, but still resolve.
      serviceLogger.warn(
        { lifecycle: lifecycle.name, itemType },
        'Driven lifecycle has no changeActionMappings configured',
      )
    }

    return {
      id: lifecycle.id,
      name: lifecycle.name,
      states: lifecycle.states,
      transitions: lifecycle.transitions,
      changeActionMappings: lifecycle.changeActionMappings ?? {},
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
   * A `null` means the lifecycle defines no such action: the type does not
   * release (Free lifecycles), does not obsolete, or names no superseded
   * state. There are no literal fallbacks left — every item type has a
   * lifecycle, and what its actions produce is entirely the lifecycle's say.
   */
  static async resolveActionStates(
    itemType: string,
  ): Promise<ResolvedActionStates> {
    const releaseState = await this.getTargetState(itemType, 'release')

    return {
      releaseState,
      obsoleteState: await this.getTargetState(itemType, 'obsolete'),
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
   * The states a release stamps onto NEW versions: `release.toState` and
   * `revise.newVersionState`. "Has this design released anything" questions
   * key off these; Free lifecycles contribute nothing.
   */
  static async getReleaseTargetStates(
    itemType: string,
  ): Promise<Array<string>> {
    const states = await this.resolveActionStates(itemType)
    return [
      ...new Set(
        [states.releaseState, states.reviseState].filter(
          (s): s is string => s !== null,
        ),
      ),
    ]
  }

  /**
   * Every state the release machinery can leave a version in: the release
   * targets plus what obsolescence and supersession stamp. A version in one
   * of these states is immutable released lineage — never edited in place.
   *
   * Closed by construction: when a lifecycle names no superseded state the
   * merge leaves prior versions in their own (release) state, so nothing the
   * machinery writes falls outside this set. Empty for Free lifecycles,
   * whose items are not release-controlled at all.
   */
  static async getReleasedFamilyStates(
    itemType: string,
  ): Promise<Array<string>> {
    const states = await this.resolveActionStates(itemType)
    return [
      ...new Set(
        [
          states.releaseState,
          states.reviseState,
          states.obsoleteState,
          states.supersededState,
        ].filter((s): s is string => s !== null),
      ),
    ]
  }

  /** Whether `state` is immutable released lineage for this type. */
  static async isReleasedFamilyState(
    itemType: string,
    state: string | null | undefined,
  ): Promise<boolean> {
    if (state == null) return false
    return (await this.getReleasedFamilyStates(itemType)).includes(state)
  }

  /** Whether `state` is the lifecycle's initial state (the isInitial flag). */
  static async isInitialState(
    itemType: string,
    state: string | null | undefined,
  ): Promise<boolean> {
    if (state == null) return false
    const lifecycle = await this.getLifecycleForItemType(itemType)
    return lifecycle?.states.some((s) => s.isInitial && s.id === state) ?? false
  }

  /**
   * What finishing in `state` means for this type, from the state's
   * `finalKind` flag: 'complete', 'cancel', 'release' — or null when the
   * state is not final or declares no kind.
   */
  static async getFinalKind(
    itemType: string,
    state: string,
  ): Promise<'release' | 'cancel' | 'complete' | null> {
    const lifecycle = await this.getLifecycleForItemType(itemType)
    const found = lifecycle?.states.find((s) => s.id === state)
    if (!found?.isFinal) return null
    return found.finalKind ?? null
  }

  /** The state IDs flagged isFinal — where the flow ends, whatever it is named. */
  static async getFinalStateIds(itemType: string): Promise<Array<string>> {
    const lifecycle = await this.getLifecycleForItemType(itemType)
    return lifecycle?.states.filter((s) => s.isFinal).map((s) => s.id) ?? []
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
   * Throws when the type has no lifecycle or the lifecycle marks no initial
   * state. Both are configuration errors: every item type ships with a
   * default lifecycle, and definition validation enforces exactly one
   * initial state — there is deliberately no literal fallback.
   */
  /**
   * The state list governing items of this type: the item lifecycle's states,
   * or — for Driving-governed types (ChangeOrder), which
   * `getLifecycleForType` deliberately never resolves as an item lifecycle —
   * the raw assigned Driving definition's states, since a ChangeOrder item's
   * state mirrors its workflow instance.
   */
  private static async getGoverningStates(
    itemType: string,
  ): Promise<Array<{ id: string; isInitial?: boolean }> | undefined> {
    const lifecycle = await ItemTypeRegistry.getLifecycleForType(itemType)
    if (lifecycle?.states) return lifecycle.states

    const definitionId = ItemTypeRegistry.getLifecycleDefinitionId(itemType)
    if (!definitionId) return undefined
    const [row] = await db
      .select({ definition: workflowDefinitions.definition })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, definitionId))
      .limit(1)
    return (
      row?.definition as
        { states?: Array<{ id: string; isInitial?: boolean }> } | undefined
    )?.states
  }

  /**
   * The definition that governs items of this type, for presentation: the
   * item lifecycle, or — for Driving-governed types (ChangeOrder) — the raw
   * assigned Driving definition, whose states the item mirrors. Returns what
   * a client needs to render states by configuration (names, colours, flags,
   * phases) and to derive the released family (the change-action mappings).
   * Null only when the type has no assigned definition.
   *
   * Change-action *logic* must keep using `getLifecycleForItemType`, which
   * correctly never treats a Driving workflow as an item lifecycle: a change
   * order does not have a release mapping, it *is* one. Reading a state's own
   * flags (`isInitial`, `isFinal`, `finalKind`) is the other legitimate use,
   * for the same reason the private `getGoverningStates` exists — an item's
   * `state` column mirrors those states whichever kind of definition governs
   * it, so `getLifecycleForItemType` would report every change order
   * stateless. `ItemService.requireNoRetainedEvidence` is the caller.
   */
  static async getGoverningDefinition(itemType: string): Promise<{
    id: string
    name: string
    lifecycleType: LifecycleType
    states: Array<WorkflowState>
    transitions: Array<WorkflowTransition>
    phases: Array<LifecyclePhaseConfig>
    revisionScheme: RevisionScheme | null
    changeActionMappings: ChangeActionMappings
  } | null> {
    const lifecycle = await this.getLifecycleForItemType(itemType)
    if (lifecycle) {
      return {
        id: lifecycle.id,
        name: lifecycle.name,
        lifecycleType: await this.getLifecycleType(itemType),
        states: lifecycle.states,
        transitions: lifecycle.transitions ?? [],
        phases: lifecycle.phases ?? [],
        revisionScheme: lifecycle.revisionScheme ?? null,
        changeActionMappings: lifecycle.changeActionMappings,
      }
    }

    const definitionId = ItemTypeRegistry.getLifecycleDefinitionId(itemType)
    if (!definitionId) return null
    const { WorkflowService } = await import('../workflows/WorkflowService')
    const definition = await WorkflowService.getById(definitionId)
    if (!definition) return null
    return {
      id: definition.id,
      name: definition.name,
      lifecycleType: resolveLifecycleType(definition),
      states: definition.states,
      transitions: definition.transitions ?? [],
      phases:
        (definition as { phases?: Array<LifecyclePhaseConfig> }).phases ?? [],
      revisionScheme:
        (definition as { revisionScheme?: RevisionScheme }).revisionScheme ??
        null,
      changeActionMappings: definition.changeActionMappings ?? {},
    }
  }

  /**
   * Reject a state the type's lifecycle does not define. The schema layer
   * deliberately types `state` as a plain string — the state universe is
   * runtime configuration, so it cannot be a compile-time enum; this is the
   * boundary check in its place.
   */
  static async validateStateForType(
    itemType: string,
    state: string,
  ): Promise<void> {
    const states = await this.getGoverningStates(itemType)
    if (!states) return // no governing definition to validate against
    if (!states.some((s) => s.id === state)) {
      throw new ValidationError(
        `'${state}' is not a state of the ${itemType} lifecycle. Valid states: ${states
          .map((s) => s.id)
          .join(', ')}`,
      )
    }
  }

  static async getInitialStateId(itemType: string): Promise<string> {
    const states = await this.getGoverningStates(itemType)
    const initialState = states?.find((s) => s.isInitial)
    if (!initialState) {
      throw new InternalError(
        states
          ? `The lifecycle for ${itemType} marks no initial state`
          : `Item type ${itemType} has no lifecycle assigned. Every item type requires one — run the seed (npm run db:seed) or assign a lifecycle in the admin item-type config.`,
      )
    }
    return initialState.id
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
      const family = await this.getReleasedFamilyStates(item.itemType)
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
        await import('./WorkOrderInstructionService')
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
    let instance = await WorkflowService.getInstanceByItemId(itemId)
    if (!instance) {
      try {
        instance = await WorkflowService.startInstance(lifecycle.id, itemId, {
          actorId: userId,
        })
      } catch (error) {
        // `workflow_instances_one_active_per_item` makes the loser of a
        // concurrent lazy create fail. Adopt the winner's instance and carry
        // on — the PhysicalPartService.register shape. Matched on error
        // class, never on a message.
        if (!(error instanceof AlreadyExistsError)) throw error
        instance = await WorkflowService.getInstanceByItemId(itemId)
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
      // A concurrent writer may have made exactly this move between the read
      // above and the compare-and-swap inside transition(). Ask the instance
      // where it actually is rather than parsing why the attempt failed: if
      // it is in the target state, the goal is met and this call succeeded;
      // anything else is a genuine rejection and still throws.
      const settled = await WorkflowService.getInstance(instance.id)
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
        ? await this.getReleasedFamilyStates(item.itemType)
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
