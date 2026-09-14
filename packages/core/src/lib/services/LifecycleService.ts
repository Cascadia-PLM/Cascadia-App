// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Service for lifecycle-specific operations.
 *
 * Unified Lifecycle Model:
 * - Free: self-controlled, with manual transitions (Issues, Tools)
 * - Driven: change-order-controlled; declares its states and the
 *   changeActionMappings the merge applies at release (Parts, Documents,
 *   Requirements)
 * - Driving: a change-order approval workflow whose completion in a
 *   `finalKind: 'release'` state triggers the release (ECO workflows)
 *
 * changeActionMappings are the one mechanism by which a change order moves an
 * item's state; this service resolves them.
 */

import { eq } from 'drizzle-orm'
import { db } from '../db'
import { lifecycleDefinitions } from '../db/schema/lifecycles'
import { ItemTypeRegistry } from '../items/registry'
import { InternalError, ValidationError } from '../errors'
import { resolveLifecycleType } from '../lifecycles/normalize'
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
  InstanceTransition,
  LifecycleDefinition,
  LifecycleState,
  LifecycleTransition,
  LifecycleType,
} from '../lifecycles/types'
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
  states: Array<LifecycleState>
  transitions?: Array<LifecycleTransition>
  changeActionMappings: ChangeActionMappings
  revisionScheme?: RevisionScheme
  phases?: Array<LifecyclePhaseConfig>
}

/**
 * What governs one item: `getGoverningDefinitionForItem`'s answer. The
 * transitions may be instance-level ones when the item runs a flexible
 * workflow with a structure of its own.
 */
export interface ItemGoverningDefinition {
  id: string
  name: string
  lifecycleType: LifecycleType
  states: Array<LifecycleState>
  transitions: Array<LifecycleTransition | InstanceTransition>
  phases: Array<LifecyclePhaseConfig>
  revisionScheme: RevisionScheme | null
  changeActionMappings: ChangeActionMappings
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
   * Where `state` sits in the type's lifecycle, as flags: initial, released
   * family, final and what finishing there means. The shape an extension's
   * guard intent carries, so a rule keys on semantics rather than on a state
   * id somebody can rename.
   */
  static async statePosition(
    itemType: string,
    state: string | null | undefined,
  ): Promise<{
    isInitial: boolean
    isReleased: boolean
    isFinal: boolean
    finalKind: 'release' | 'cancel' | 'complete' | null
  }> {
    if (state == null) {
      return {
        isInitial: false,
        isReleased: false,
        isFinal: false,
        finalKind: null,
      }
    }
    const lifecycle = await this.getLifecycleForItemType(itemType)
    const found = lifecycle?.states.find((s) => s.id === state)
    return {
      isInitial: found?.isInitial === true,
      isReleased: await this.isReleasedFamilyState(itemType, state),
      isFinal: found?.isFinal === true,
      finalKind: found?.isFinal ? (found.finalKind ?? null) : null,
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
   * Throws when the type has no lifecycle or the lifecycle marks no initial
   * state. Both are configuration errors: every item type ships with a
   * default lifecycle, and definition validation enforces exactly one
   * initial state — there is deliberately no literal fallback.
   */
  /**
   * The state list governing items of this type: the assigned definition's
   * states whatever its kind. For Driving-governed types (ChangeOrder), which
   * `getLifecycleForType` deliberately never resolves as an item lifecycle,
   * that is the raw Driving definition, since a ChangeOrder item's state
   * mirrors its workflow instance.
   */
  private static async getGoverningStates(
    itemType: string,
  ): Promise<Array<{ id: string; isInitial?: boolean }> | undefined> {
    return (await ItemTypeRegistry.getAssignedDefinitionForType(itemType))
      ?.states
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
    states: Array<LifecycleState>
    transitions: Array<LifecycleTransition>
    phases: Array<LifecyclePhaseConfig>
    revisionScheme: RevisionScheme | null
    changeActionMappings: ChangeActionMappings
  } | null> {
    const definition =
      await ItemTypeRegistry.getAssignedDefinitionForType(itemType)
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
    // Every state the type can hold, not only the governing definition's: a
    // change order runs whichever definition its change type maps to
    const states = await this.getRenderableStates(itemType)
    if (states.length === 0) return // no governing definition to validate against
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

  /**
   * The definition governing one item, for presentation and for reading a
   * state's own flags: the workflow instance the item is actually running
   * when it has one — with the instance's own states and transitions for a
   * flexible workflow — otherwise the type's governing definition.
   *
   * The type-level answer is wrong for a change order whose change type maps
   * to a definition other than the type's `lifecycleDefinitionId`
   * (`lifecyclesByChangeType`; XCO runs the flexible definition): its `state`
   * mirrors its instance, and the type's definition need not contain the id.
   */
  static async getGoverningDefinitionForItem(item: {
    id: string
    itemType: string
  }): Promise<ItemGoverningDefinition | null> {
    const { LifecycleInstanceService } =
      await import('../lifecycles/LifecycleInstanceService')
    const instance = await LifecycleInstanceService.getInstanceByItemId(item.id)
    if (!instance) return this.getGoverningDefinition(item.itemType)

    const structure = await LifecycleInstanceService.getEffectiveStructure(
      instance.id,
    )
    const definition = structure.definition
    return {
      id: definition.id,
      name: definition.name,
      lifecycleType: resolveLifecycleType(definition),
      states: structure.states,
      transitions: structure.transitions,
      phases:
        (definition as { phases?: Array<LifecyclePhaseConfig> }).phases ?? [],
      revisionScheme:
        (definition as { revisionScheme?: RevisionScheme }).revisionScheme ??
        null,
      changeActionMappings: definition.changeActionMappings ?? {},
    }
  }

  /**
   * Every state an item of this type can hold, for rendering: the governing
   * definition's states plus, for a type whose change types map to further
   * Driving definitions (`lifecyclesByChangeType`), those definitions' states.
   * A list of change orders spans all of them, and a badge that knew only the
   * type's `lifecycleDefinitionId` could not name an XCO's states at all.
   * First seen wins on id, so the governing definition's colours and flags
   * take precedence.
   */
  static async getRenderableStates(
    itemType: string,
  ): Promise<Array<LifecycleState>> {
    const governing = await this.getGoverningDefinition(itemType)
    const states: Array<LifecycleState> = governing ? [...governing.states] : []
    const seen = new Set(states.map((s) => s.id))

    // Runtime configuration, so the same freshness check the lifecycle
    // lookups make. (`governing` above already went through one.)
    await ItemTypeRegistry.ensureFresh()
    const mapped =
      ItemTypeRegistry.getRuntimeConfig(itemType)?.lifecyclesByChangeType
    if (!mapped) return states

    const { LifecycleDefinitionService } =
      await import('../lifecycles/LifecycleDefinitionService')
    const definitionIds = [...new Set(Object.values(mapped))].filter(
      (id): id is string => typeof id === 'string' && id !== governing?.id,
    )
    for (const definitionId of definitionIds) {
      const definition = await LifecycleDefinitionService.getById(definitionId)
      for (const state of definition?.states ?? []) {
        if (seen.has(state.id)) continue
        seen.add(state.id)
        states.push(state)
      }
    }
    return states
  }

  // ============================================
  // Phase Resolution Methods
  // ============================================

  /**
   * Get the phase configuration for a state in a lifecycle.
   * Uses the state's phaseId to look up the phase definition.
   */
  static getPhaseForState(
    lifecycle: ResolvedLifecycle | LifecycleDefinition,
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
    lifecycle: ResolvedLifecycle | LifecycleDefinition,
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
    lifecycle: ResolvedLifecycle | LifecycleDefinition,
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
   * The lifecycle kind of an item type — Free, Driven or Driving — read from
   * the definition assigned to it, whatever that definition is. `null` when
   * the type has nothing assigned or the assignment matches no row: callers
   * decide what an unknown kind means, and the one guarding released data
   * (`isBranchProtectionExempt`) treats it as ECO-controlled.
   *
   * This used to answer 'Free' for anything the registry did not resolve as
   * an item lifecycle, which covered three different situations — nothing
   * assigned, a Driving assignment (deliberately not an item lifecycle), and
   * a failed lookup — and 'Free' is the kind branch protection exempts. A
   * failed lookup now propagates from the registry; the other two are told
   * apart here.
   */
  static async getLifecycleType(
    itemType: string,
  ): Promise<LifecycleType | null> {
    const definition =
      await ItemTypeRegistry.getAssignedDefinitionForType(itemType)
    return definition ? resolveLifecycleType(definition) : null
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
        drivers: lifecycleDefinitions.drivers,
      })
      .from(lifecycleDefinitions)
      .where(eq(lifecycleDefinitions.id, lifecycleId))
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
    states: Array<LifecycleState>
    drivers: Array<string>
  } | null> {
    const result = await db
      .select()
      .from(lifecycleDefinitions)
      .where(eq(lifecycleDefinitions.id, lifecycleId))
      .limit(1)

    const row = result.at(0)
    if (!row) {
      return null
    }

    const def = row.definition as { states?: Array<LifecycleState> }

    return {
      id: row.id,
      name: row.name,
      // The column is the one source of truth (migration 0006)
      lifecycleType: row.lifecycleType,
      states: def.states ?? [],
      drivers: row.drivers ?? [],
    }
  }
}
