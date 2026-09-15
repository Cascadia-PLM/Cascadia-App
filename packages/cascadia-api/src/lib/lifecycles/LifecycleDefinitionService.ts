// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  lifecycleDefinitions,
  lifecycleInstances,
} from '../db/schema/lifecycles'
import { items } from '../db/schema/items'
import { ItemTypeRegistry } from '../items/registry'
import { notDeleted } from '../db/filters'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { isDrivingDefinition, resolveLifecycleType } from './normalize'
import type {
  CreateLifecycleInput,
  ValidationError as DefinitionValidationIssue,
  LifecycleDefinition,
  LifecycleType,
  UpdateLifecycleInput,
  ValidationResult,
  ValidationWarning,
} from './types'
import { takeFirst } from '@/lib/db/take-first'

/**
 * Columns an `update_field` workflow action may write on the base `items`
 * table (the only table it touches — `description` and other type-specific
 * fields live on the type tables and are not reachable here).
 * Lifecycle-controlled columns (state/revision/isCurrent) and identity
 * columns must never be writable from workflow configuration (WI-2.3);
 * enforced both at definition save and at execution time, because raw
 * inserts can bypass save-time validation.
 */
export const UPDATE_FIELD_ALLOWED_COLUMNS: ReadonlySet<string> = new Set([
  'name',
])

/**
 * Lifecycle definitions: create, read, update and delete, and the
 * validation that decides what a definition may say. The runtime —
 * instances, transitions, the release claim, history — is
 * `LifecycleInstanceService`; approvals are `ApprovalService`. Split from
 * the one `WorkflowService` along these seams (remediation plan CM-22).
 */
export class LifecycleDefinitionService {
  // ============================================
  // CRUD Operations
  // ============================================

  /**
   * Create a new workflow definition
   */
  static async create(
    input: CreateLifecycleInput,
  ): Promise<LifecycleDefinition> {
    // Validate the workflow structure
    const validation = this.validateDefinition(input)
    if (!validation.valid) {
      throw new ValidationError(
        `Invalid workflow definition: ${validation.errors.map((e) => e.message).join(', ')}`,
      )
    }

    await this.validateDriverIds(input.drivers)

    // The column is the kind's one home (migration 0006); an input that
    // leaves it unsaid is Free
    const lifecycleType = resolveLifecycleType(input)

    const definition = {
      states: input.states,
      transitions: input.transitions,
      description: input.description,
      applicableItemTypes: input.applicableItemTypes,
      changeActionMappings: input.changeActionMappings,
      revisionScheme: input.revisionScheme,
      phases: input.phases,
    }

    const result = takeFirst(
      await db
        .insert(lifecycleDefinitions)
        .values({
          name: input.name,
          version: 1,
          workflowType: input.workflowType,
          definition,
          isActive: input.isActive ?? true,
          lifecycleType,
          drivers: input.drivers ?? [],
        })
        .returning(),
    )

    ItemTypeRegistry.invalidateLifecycleCache()

    return this.mapToLifecycleDefinition(result)
  }

  /**
   * WI-4.4: a Driven lifecycle's `drivers` allow-list may only reference
   * existing Driving definitions — a typo'd or wrong-kind ID would silently
   * lock every ECO out (or worse, appear to authorize nothing).
   */
  private static async validateDriverIds(
    drivers: Array<string> | undefined,
  ): Promise<void> {
    if (!drivers || drivers.length === 0) return

    const rows = await db
      .select({
        id: lifecycleDefinitions.id,
        name: lifecycleDefinitions.name,
        lifecycleType: lifecycleDefinitions.lifecycleType,
      })
      .from(lifecycleDefinitions)
      .where(inArray(lifecycleDefinitions.id, drivers))

    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const driverId of drivers) {
      const row = byId.get(driverId)
      if (!row) {
        throw new ValidationError(
          `Driver ${driverId} does not reference an existing workflow definition`,
        )
      }
      const kind = row.lifecycleType
      if (kind !== 'Driving') {
        throw new ValidationError(
          `Driver "${row.name}" is a ${kind} lifecycle — only Driving lifecycles can act on Driven items`,
        )
      }
    }
  }

  /**
   * Get a workflow definition by ID
   */
  static async getById(id: string): Promise<LifecycleDefinition | null> {
    const results = await db
      .select()
      .from(lifecycleDefinitions)
      .where(eq(lifecycleDefinitions.id, id))
      .limit(1)

    if (results.length === 0) return null
    return this.mapToLifecycleDefinition(results[0])
  }

  /**
   * Get a workflow definition by name
   */
  static async getByName(name: string): Promise<LifecycleDefinition | null> {
    const results = await db
      .select()
      .from(lifecycleDefinitions)
      .where(eq(lifecycleDefinitions.name, name))
      .limit(1)

    if (results.length === 0) return null
    return this.mapToLifecycleDefinition(results[0])
  }

  /**
   * List all workflow definitions
   */
  static async list(filters?: {
    isActive?: boolean
    /**
     * Coarse API-facing filter: 'workflow' = Driving (change-order
     * workflows), 'lifecycle' = everything else (Driven and Free item
     * lifecycles). Resolved via lifecycleType, not the legacy field.
     */
    kind?: 'lifecycle' | 'workflow'
    /** The model's own kind, by name — beside `kind`, which predates it. */
    lifecycleType?: LifecycleType
  }): Promise<Array<LifecycleDefinition>> {
    let query = db.select().from(lifecycleDefinitions)

    const conditions = []
    if (filters?.isActive !== undefined) {
      conditions.push(eq(lifecycleDefinitions.isActive, filters.isActive))
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query
    }

    const results = await query.orderBy(desc(lifecycleDefinitions.createdAt))

    let definitions = results.map((r) => this.mapToLifecycleDefinition(r))

    if (filters?.kind) {
      definitions = definitions.filter((d) =>
        filters.kind === 'workflow'
          ? isDrivingDefinition(d)
          : !isDrivingDefinition(d),
      )
    }
    if (filters?.lifecycleType) {
      definitions = definitions.filter(
        (d) => resolveLifecycleType(d) === filters.lifecycleType,
      )
    }

    return definitions
  }

  /**
   * Update a workflow definition
   */
  static async update(
    id: string,
    rawInput: UpdateLifecycleInput,
  ): Promise<LifecycleDefinition> {
    const existing = await this.getById(id)
    if (!existing) {
      throw new NotFoundError('Workflow definition', id)
    }

    // An absent (undefined) key means "keep the stored value". Strip
    // undefined entries before spreading so a caller passing explicit
    // undefined (e.g. a route forwarding optional body fields) cannot
    // clobber stored fields like changeActionMappings.
    const input = Object.fromEntries(
      Object.entries(rawInput).filter(([, value]) => value !== undefined),
    ) as UpdateLifecycleInput

    // Merge updates
    const updated = {
      ...existing,
      ...input,
      states: input.states ?? existing.states,
      transitions: input.transitions ?? existing.transitions,
    }

    // Validate the updated workflow
    const validation = this.validateDefinition(updated)
    if (!validation.valid) {
      throw new ValidationError(
        `Invalid workflow definition: ${validation.errors.map((e) => e.message).join(', ')}`,
      )
    }

    // For item lifecycles (Driven and Free), validate that removed states
    // don't have items in them. Driving definitions are exempt: strict
    // instances complete before edits matter and flexible instances carry
    // their own copied structure. (Phase-3 leftover fixed here: this gate
    // used to read the legacy definitionType field.)
    if (resolveLifecycleType(existing) !== 'Driving' && input.states) {
      const stateValidation = await this.validateStateRemoval(
        id,
        existing.states,
        input.states,
      )
      if (!stateValidation.valid) {
        throw new ValidationError(stateValidation.errors.join('; '))
      }
    }

    // Drivers are replaced wholesale when provided; validate the new list
    if (input.drivers !== undefined) {
      await this.validateDriverIds(input.drivers)
    }

    // Determine lifecycle type
    const lifecycleType = input.lifecycleType ?? existing.lifecycleType

    const definition = {
      states: updated.states,
      transitions: updated.transitions,
      description: updated.description,
      applicableItemTypes: updated.applicableItemTypes,
      changeActionMappings: updated.changeActionMappings,
      revisionScheme: input.revisionScheme ?? (existing as any).revisionScheme,
      phases: input.phases ?? (existing as any).phases,
    }

    const [result] = await db
      .update(lifecycleDefinitions)
      .set({
        name: updated.name,
        definition,
        isActive: updated.isActive,
        lifecycleType,
        drivers: input.drivers ?? existing.drivers ?? [],
      })
      .where(eq(lifecycleDefinitions.id, id))
      .returning()

    // Item types resolve their lifecycle through a memo in the registry; an
    // edit that does not drop it stays invisible until the process restarts
    ItemTypeRegistry.invalidateLifecycleCache()

    return this.mapToLifecycleDefinition(result)
  }

  /**
   * Delete a workflow definition
   */
  static async delete(id: string): Promise<void> {
    const existing = await this.getById(id)
    if (!existing) {
      throw new NotFoundError('Workflow definition', id)
    }

    // Check if there are active instances
    const activeInstances = await db
      .select()
      .from(lifecycleInstances)
      .where(
        and(
          eq(lifecycleInstances.workflowDefinitionId, id),
          isNull(lifecycleInstances.completedAt),
        ),
      )
      .limit(1)

    if (activeInstances.length > 0) {
      throw new ConflictError('Cannot delete workflow with active instances')
    }

    // Any definition assigned to item types is load-bearing — Driving
    // workflows back ChangeOrder configs the same way Driven lifecycles
    // back Parts. (The old gate here read the legacy definitionType field
    // and skipped the check for Driving definitions entirely.)
    const itemTypesUsingLifecycle =
      ItemTypeRegistry.getItemTypesUsingLifecycle(id)
    if (itemTypesUsingLifecycle.length > 0) {
      throw new ConflictError(
        `Cannot delete lifecycle '${existing.name}': ` +
          `It is assigned to item types: ${itemTypesUsingLifecycle.join(', ')}. ` +
          `Remove the lifecycle assignment from these item types first.`,
      )
    }

    await db.delete(lifecycleDefinitions).where(eq(lifecycleDefinitions.id, id))
    ItemTypeRegistry.invalidateLifecycleCache()
  }

  // ============================================
  // Validation
  // ============================================

  /**
   * Validate a workflow definition structure
   */
  static validateDefinition(
    definition: Partial<LifecycleDefinition>,
  ): ValidationResult {
    const errors: Array<DefinitionValidationIssue> = []
    const warnings: Array<ValidationWarning> = []

    // Check required fields
    if (!definition.name) {
      errors.push({
        code: 'MISSING_NAME',
        message: 'Workflow name is required',
      })
    }

    if (!definition.states || definition.states.length === 0) {
      errors.push({
        code: 'NO_STATES',
        message: 'Workflow must have at least one state',
      })
    }

    if (definition.states) {
      // Check for initial state
      const initialStates = definition.states.filter((s) => s.isInitial)
      if (initialStates.length === 0) {
        errors.push({
          code: 'NO_INITIAL_STATE',
          message: 'Workflow must have an initial state',
        })
      } else if (initialStates.length > 1) {
        errors.push({
          code: 'MULTIPLE_INITIAL_STATES',
          message: 'Workflow can only have one initial state',
        })
      }

      // Check for duplicate state IDs
      const stateIds = definition.states.map((s) => s.id)
      const duplicateIds = stateIds.filter(
        (id, i) => stateIds.indexOf(id) !== i,
      )
      if (duplicateIds.length > 0) {
        errors.push({
          code: 'DUPLICATE_STATE_IDS',
          message: `Duplicate state IDs: ${duplicateIds.join(', ')}`,
        })
      }

      // Check for final state (warning only)
      const finalStates = definition.states.filter((s) => s.isFinal)
      if (finalStates.length === 0) {
        warnings.push({
          code: 'NO_FINAL_STATE',
          message: 'Consider marking a state as final',
        })
      }

      // Driving lifecycles: every final state must declare what finishing
      // there means. The release-vs-cancel decision is made from finalKind
      // alone — never inferred from the state's name.
      if (isDrivingDefinition(definition)) {
        for (const state of finalStates) {
          if (state.finalKind !== 'release' && state.finalKind !== 'cancel') {
            errors.push({
              code: 'MISSING_FINAL_KIND',
              message: `Final state "${state.name}" must declare finalKind: 'release' (merge and assign revisions) or 'cancel' (archive without merging)`,
              path: `states.${state.id}`,
            })
          }
        }
      }

      // State identity is IDs everywhere (WI-5.1): every state reference in
      // changeActionMappings must be an existing state ID. This replaces the
      // Phase-1 id===name guardrail — display names are free to differ from
      // IDs now, so a mapping written with a display name is an error, not a
      // coincidence to preserve.
      if (definition.changeActionMappings) {
        const stateIdSet = new Set(definition.states.map((s) => s.id))
        for (const [action, mapping] of Object.entries(
          definition.changeActionMappings,
        )) {
          if (!mapping || typeof mapping !== 'object') continue
          for (const [key, value] of Object.entries(
            mapping as Record<string, unknown>,
          )) {
            if (
              typeof value === 'string' &&
              /state/i.test(key) &&
              !stateIdSet.has(value)
            ) {
              errors.push({
                code: 'MAPPING_UNKNOWN_STATE',
                message: `changeActionMappings.${action}.${key} references "${value}", which is not a state ID — mappings are keyed by state IDs, not display names`,
                path: `changeActionMappings.${action}`,
              })
            }
          }
        }
      }
    }

    if (definition.transitions) {
      // Validate transitions reference valid states
      const stateIds = new Set(definition.states?.map((s) => s.id) || [])

      for (const transition of definition.transitions) {
        if (!stateIds.has(transition.fromStateId)) {
          errors.push({
            code: 'INVALID_FROM_STATE',
            message: `Transition "${transition.name}" references non-existent from state: ${transition.fromStateId}`,
            path: `transitions.${transition.id}`,
          })
        }
        if (!stateIds.has(transition.toStateId)) {
          errors.push({
            code: 'INVALID_TO_STATE',
            message: `Transition "${transition.name}" references non-existent to state: ${transition.toStateId}`,
            path: `transitions.${transition.id}`,
          })
        }

        // Retired knobs must not survive a save: definitions carrying
        // approval_count guards or create_task actions would fail at
        // runtime, so reject them here with a pointer to the replacement.
        // Runtime input can carry any string, so compare wider than the
        // compile-time unions.
        for (const guard of transition.guards ?? []) {
          const guardType: string = guard.type
          if (guardType !== 'field_value' && guardType !== 'user_role') {
            errors.push({
              code: 'UNKNOWN_GUARD_TYPE',
              message: `Guard "${guard.name}" has unsupported type "${guardType}" — approval gating is configured through state approvers, not guards`,
              path: `transitions.${transition.id}`,
            })
          }
        }

        for (const action of transition.actions ?? []) {
          const actionType: string = action.type
          if (
            actionType !== 'send_notification' &&
            actionType !== 'update_field'
          ) {
            errors.push({
              code: 'UNKNOWN_ACTION_TYPE',
              message: `Action "${action.name}" has unsupported type "${actionType}"`,
              path: `transitions.${transition.id}`,
            })
          }

          // update_field actions may only touch allowlisted item columns —
          // lifecycle-controlled fields are never writable from configuration
          if (action.type !== 'update_field') continue
          const fieldName = (
            action.config as { fieldName?: string } | undefined
          )?.fieldName
          if (!fieldName || !UPDATE_FIELD_ALLOWED_COLUMNS.has(fieldName)) {
            errors.push({
              code: 'UPDATE_FIELD_NOT_ALLOWED',
              message: `Action "${action.name}" may only update ${[...UPDATE_FIELD_ALLOWED_COLUMNS].join(', ')} — not "${fieldName ?? '(missing fieldName)'}"`,
              path: `transitions.${transition.id}`,
            })
          }
        }
      }

      // Check for orphaned states (no transitions in or out)
      if (definition.states && definition.states.length > 1) {
        for (const state of definition.states) {
          const hasOutgoing = definition.transitions.some(
            (t) => t.fromStateId === state.id,
          )
          const hasIncoming = definition.transitions.some(
            (t) => t.toStateId === state.id,
          )

          if (!state.isInitial && !hasIncoming) {
            warnings.push({
              code: 'UNREACHABLE_STATE',
              message: `State "${state.name}" has no incoming transitions`,
              path: `states.${state.id}`,
            })
          }

          if (!state.isFinal && !hasOutgoing) {
            warnings.push({
              code: 'DEAD_END_STATE',
              message: `State "${state.name}" has no outgoing transitions`,
              path: `states.${state.id}`,
            })
          }
        }
      }
    }

    // Validate phases if defined
    if (definition.phases && definition.phases.length > 0) {
      // Check for duplicate phase IDs
      const phaseIds = definition.phases.map((p) => p.id)
      const duplicatePhaseIds = phaseIds.filter(
        (id, i) => phaseIds.indexOf(id) !== i,
      )
      if (duplicatePhaseIds.length > 0) {
        errors.push({
          code: 'DUPLICATE_PHASE_IDS',
          message: `Duplicate phase IDs: ${duplicatePhaseIds.join(', ')}`,
        })
      }

      const phaseIdSet = new Set(phaseIds)

      if (definition.states) {
        // Check that state phaseIds reference existing phases
        for (const state of definition.states) {
          if (state.phaseId && !phaseIdSet.has(state.phaseId)) {
            errors.push({
              code: 'INVALID_PHASE_REF',
              message: `State "${state.name}" references non-existent phase: ${state.phaseId}`,
              path: `states.${state.id}`,
            })
          }
        }

        // Warn about phases with no assigned states
        for (const phase of definition.phases) {
          const hasStates = definition.states.some(
            (s) => s.phaseId === phase.id,
          )
          if (!hasStates) {
            warnings.push({
              code: 'EMPTY_PHASE',
              message: `Phase "${phase.name}" has no assigned states`,
              path: `phases.${phase.id}`,
            })
          }
        }

        // Warn about states without phaseId when phases are defined
        const statesWithoutPhase = definition.states.filter((s) => !s.phaseId)
        if (statesWithoutPhase.length > 0) {
          warnings.push({
            code: 'STATES_WITHOUT_PHASE',
            message: `States without phase assignment: ${statesWithoutPhase.map((s) => s.name).join(', ')}`,
          })
        }
      }

      // Validate promote mapping crosses phase boundaries.
      // Mapping values are state IDs (WI-5.1) — no name fallback.
      if (definition.changeActionMappings?.promote && definition.states) {
        const promoteMapping = definition.changeActionMappings.promote
        const fromState = definition.states.find(
          (s) => s.id === promoteMapping.fromState,
        )
        const toState = definition.states.find(
          (s) => s.id === promoteMapping.toState,
        )
        if (
          fromState?.phaseId &&
          toState?.phaseId &&
          fromState.phaseId === toState.phaseId
        ) {
          errors.push({
            code: 'PROMOTE_SAME_PHASE',
            message: `Promote mapping's from/to states must be in different phases`,
          })
        }
      }
    }

    // A lifecycle-level `none` revision scheme is incompatible with a Driven
    // lifecycle, and the incompatibility is structural rather than stylistic.
    // Releasing on a Driven lifecycle mints a NEW `items` row per version,
    // and (item_number, revision, design_id, item_type) is unique — so a
    // scheme whose revision never advances makes the *second* release of any
    // item a unique violation, thrown from inside the merge transaction with
    // nothing useful to say. Refuse the configuration at save time instead of
    // failing the release that discovers it.
    //
    // An error, not a warning: a warning still lets the definition be saved,
    // and the failure it warns about lands on a different person days later.
    //
    // Phase-level `none` overrides stay legal. They are read only by the
    // promote path (`LifecycleService.getEffectiveTransition`), which updates
    // the item in place and mints no row.
    if (
      definition.revisionScheme?.type === 'none' &&
      resolveLifecycleType(definition) === 'Driven'
    ) {
      errors.push({
        code: 'NONE_SCHEME_ON_DRIVEN',
        message:
          `Revision scheme 'none' is not valid for a Driven lifecycle: each release creates a new version of the item, ` +
          `and two versions of one item cannot share a revision. Use 'none' on a lifecycle whose items are updated in ` +
          `place (Free), or as a phase-level override.`,
        path: 'revisionScheme',
      })
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Validate that states being removed from a lifecycle don't have items in them.
   * Called when updating a lifecycle definition.
   */
  static async validateStateRemoval(
    lifecycleId: string,
    currentStates: LifecycleDefinition['states'],
    newStates: LifecycleDefinition['states'],
  ): Promise<{ valid: boolean; errors: Array<string> }> {
    // Find states that are being removed. State identity is IDs (WI-5.1):
    // a renamed state keeps its ID and is not a removal.
    const newStateIds = new Set(newStates.map((s) => s.id))
    const removedStates = currentStates.filter((s) => !newStateIds.has(s.id))

    if (removedStates.length === 0) {
      return { valid: true, errors: [] }
    }

    // Get item types that use this lifecycle
    const itemTypesUsingLifecycle =
      ItemTypeRegistry.getItemTypesUsingLifecycle(lifecycleId)

    if (itemTypesUsingLifecycle.length === 0) {
      // No item types use this lifecycle, so removal is always safe
      return { valid: true, errors: [] }
    }

    // Check if any items are in the states being removed. Stored item
    // state is an ID (WI-5.2 normalized the data) — match by ID only.
    const removedStateIds = removedStates.map((s) => s.id)
    const errors: Array<string> = []

    const itemCounts = await db
      .select({
        state: items.state,
        itemType: items.itemType,
        count: sql<number>`count(*)::int`,
      })
      .from(items)
      .where(
        and(
          inArray(items.itemType, itemTypesUsingLifecycle),
          inArray(items.state, removedStateIds),
          notDeleted(),
        ),
      )
      .groupBy(items.state, items.itemType)

    for (const row of itemCounts) {
      if (row.count > 0) {
        const state = removedStates.find((s) => s.id === row.state)
        errors.push(
          `Cannot remove state '${state?.name || row.state}': ` +
            `${row.count} ${row.itemType}(s) are currently in this state`,
        )
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Map database result to LifecycleDefinition
   */
  private static mapToLifecycleDefinition(result: any): LifecycleDefinition {
    const def = result.definition
    // The column is the one source of truth (migration 0006)
    const lifecycleType = result.lifecycleType as LifecycleType

    return {
      id: result.id,
      name: result.name,
      version: result.version,
      workflowType: result.workflowType,
      description: def.description,
      applicableItemTypes: def.applicableItemTypes,
      states: def.states || [],
      transitions: def.transitions || [],
      changeActionMappings: def.changeActionMappings,
      isActive: result.isActive ?? true,
      createdAt: result.createdAt,
      // Unified lifecycle model fields
      lifecycleType,
      drivers: result.drivers ?? def.drivers ?? [],
      // Revision & phase configuration
      revisionScheme: def.revisionScheme,
      phases: def.phases,
    }
  }
}
