// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  workflowDefinitions,
  workflowHistory,
  workflowInstances,
} from '../db/schema/workflows'
import { items } from '../db/schema/items'
import { ItemTypeRegistry } from '../items/registry'
import { permissionService } from '../auth/permission-service'
import { notDeleted } from '../db/filters'
import { ConflictError, NotFoundError, ValidationError } from '../errors'
import { GuardEvaluator } from './GuardEvaluator'
import {
  isDrivingDefinition,
  resolveLifecycleType,
  resolveStoredLifecycleType,
} from './normalize'
import type {
  ActionResult,
  ApprovalRequirement,
  AvailableTransition,
  CreateWorkflowInput,
  ValidationError as DefinitionValidationIssue,
  EffectiveWorkflowStructure,
  GuardContext,
  GuardResult,
  InstanceWorkflowTransition,
  SendNotificationConfig,
  TransitionAction,
  TransitionExecutionOptions,
  TransitionFlowContext,
  TransitionResult,
  UpdateWorkflowInput,
  ValidationResult,
  ValidationWarning,
  WorkflowDefinition,
  WorkflowHistoryEntry,
  WorkflowInstance,
  WorkflowState,
  WorkflowTransition,
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
 * Service layer for workflow/lifecycle operations
 * Handles CRUD, validation, transitions, and execution
 */
export class WorkflowService {
  // ============================================
  // CRUD Operations
  // ============================================

  /**
   * Create a new workflow definition
   */
  static async create(input: CreateWorkflowInput): Promise<WorkflowDefinition> {
    // Validate the workflow structure
    const validation = this.validateDefinition(input)
    if (!validation.valid) {
      throw new ValidationError(
        `Invalid workflow definition: ${validation.errors.map((e) => e.message).join(', ')}`,
      )
    }

    await this.validateDriverIds(input.drivers)

    // lifecycleType is authoritative (normalize.ts owns any legacy reads)
    const lifecycleType = resolveLifecycleType(input)

    const definition = {
      states: input.states,
      transitions: input.transitions,
      description: input.description,
      applicableItemTypes: input.applicableItemTypes,
      changeActionMappings: input.changeActionMappings,
      lifecycleType, // Also store in definition for compatibility
      revisionScheme: input.revisionScheme,
      phases: input.phases,
    }

    const result = takeFirst(
      await db
        .insert(workflowDefinitions)
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

    return this.mapToWorkflowDefinition(result)
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
        id: workflowDefinitions.id,
        name: workflowDefinitions.name,
        lifecycleType: workflowDefinitions.lifecycleType,
        definition: workflowDefinitions.definition,
      })
      .from(workflowDefinitions)
      .where(inArray(workflowDefinitions.id, drivers))

    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const driverId of drivers) {
      const row = byId.get(driverId)
      if (!row) {
        throw new ValidationError(
          `Driver ${driverId} does not reference an existing workflow definition`,
        )
      }
      const kind = resolveStoredLifecycleType(
        row.lifecycleType,
        row.definition as {
          lifecycleType?: string
          definitionType?: string
        },
      )
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
  static async getById(id: string): Promise<WorkflowDefinition | null> {
    const results = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, id))
      .limit(1)

    if (results.length === 0) return null
    return this.mapToWorkflowDefinition(results[0])
  }

  /**
   * Get a workflow definition by name
   */
  static async getByName(name: string): Promise<WorkflowDefinition | null> {
    const results = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.name, name))
      .limit(1)

    if (results.length === 0) return null
    return this.mapToWorkflowDefinition(results[0])
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
  }): Promise<Array<WorkflowDefinition>> {
    let query = db.select().from(workflowDefinitions)

    const conditions = []
    if (filters?.isActive !== undefined) {
      conditions.push(eq(workflowDefinitions.isActive, filters.isActive))
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions)) as typeof query
    }

    const results = await query.orderBy(desc(workflowDefinitions.createdAt))

    let definitions = results.map((r) => this.mapToWorkflowDefinition(r))

    if (filters?.kind) {
      definitions = definitions.filter((d) =>
        filters.kind === 'workflow'
          ? isDrivingDefinition(d)
          : !isDrivingDefinition(d),
      )
    }

    return definitions
  }

  /**
   * Update a workflow definition
   */
  static async update(
    id: string,
    rawInput: UpdateWorkflowInput,
  ): Promise<WorkflowDefinition> {
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
    ) as UpdateWorkflowInput

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
      lifecycleType, // Also store in definition for compatibility
      revisionScheme: input.revisionScheme ?? (existing as any).revisionScheme,
      phases: input.phases ?? (existing as any).phases,
    }

    const [result] = await db
      .update(workflowDefinitions)
      .set({
        name: updated.name,
        definition,
        isActive: updated.isActive,
        lifecycleType,
        drivers: input.drivers ?? existing.drivers ?? [],
      })
      .where(eq(workflowDefinitions.id, id))
      .returning()

    // Item types resolve their lifecycle through a memo in the registry; an
    // edit that does not drop it stays invisible until the process restarts
    ItemTypeRegistry.invalidateLifecycleCache()

    return this.mapToWorkflowDefinition(result)
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
      .from(workflowInstances)
      .where(
        and(
          eq(workflowInstances.workflowDefinitionId, id),
          isNull(workflowInstances.completedAt),
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

    await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, id))
    ItemTypeRegistry.invalidateLifecycleCache()
  }

  // ============================================
  // Validation
  // ============================================

  /**
   * Validate a workflow definition structure
   */
  static validateDefinition(
    definition: Partial<WorkflowDefinition>,
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
    currentStates: WorkflowDefinition['states'],
    newStates: WorkflowDefinition['states'],
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

  // ============================================
  // Workflow Instance Management
  // ============================================

  /**
   * Start a workflow instance for an item
   * For flexible workflows, copies the definition structure to the instance
   */
  static async startInstance(
    workflowDefinitionId: string,
    itemId: string,
    context?: Record<string, unknown>,
  ): Promise<WorkflowInstance> {
    const definition = await this.getById(workflowDefinitionId)
    if (!definition) {
      throw new NotFoundError('Workflow definition', workflowDefinitionId)
    }

    const initialState = definition.states.find((s) => s.isInitial)
    if (!initialState) {
      throw new ValidationError('Workflow has no initial state')
    }

    // For flexible workflows, copy the structure to the instance
    const isFlexible = definition.workflowType === 'flexible'

    let instance
    try {
      instance = takeFirst(
        await db
          .insert(workflowInstances)
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
        const { AlreadyExistsError } = await import('../errors')
        throw new AlreadyExistsError('Workflow', itemId)
      }
      throw error
    }

    // Record initial history entry
    await db.insert(workflowHistory).values({
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
  }

  /**
   * Get workflow instance by ID
   */
  static async getInstance(
    instanceId: string,
  ): Promise<WorkflowInstance | null> {
    const results = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
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
  ): Promise<WorkflowInstance | null> {
    const instanceResults = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.itemId, itemId))
      .orderBy(desc(workflowInstances.startedAt))
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
  ): Promise<Array<WorkflowHistoryEntry>> {
    const results = await db
      .select()
      .from(workflowHistory)
      .where(eq(workflowHistory.instanceId, instanceId))
      .orderBy(desc(workflowHistory.timestamp))

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
  ): Promise<EffectiveWorkflowStructure> {
    const instance = await this.getInstanceRaw(instanceId)
    if (!instance) {
      throw new NotFoundError('Workflow instance', instanceId)
    }

    const definition = await this.getById(instance.workflowDefinitionId!)
    if (!definition) {
      throw new NotFoundError('Workflow definition')
    }

    const isFlexible = definition.workflowType === 'flexible'
    const hasInstanceOverrides = instance.instanceStates !== null

    if (isFlexible && hasInstanceOverrides) {
      return {
        states: instance.instanceStates as Array<WorkflowState>,
        transitions:
          instance.instanceTransitions as Array<InstanceWorkflowTransition>,
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
    states: Array<WorkflowState>,
    transitions: Array<InstanceWorkflowTransition>,
    actorId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const instance = await this.getInstanceRaw(instanceId)
    if (!instance) {
      return { success: false, error: 'Workflow instance not found' }
    }

    const definition = await this.getById(instance.workflowDefinitionId!)
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

    // Apply update
    await db
      .update(workflowInstances)
      .set({
        instanceStates: states,
        instanceTransitions: transitions,
      })
      .where(eq(workflowInstances.id, instanceId))

    // Record in history
    await db.insert(workflowHistory).values({
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

    return { success: true }
  }

  /**
   * Check if a workflow instance is flexible and editable
   */
  static async isFlexibleAndEditable(instanceId: string): Promise<boolean> {
    const instance = await this.getInstanceRaw(instanceId)
    if (!instance || instance.completedAt) return false

    const definition = await this.getById(instance.workflowDefinitionId!)
    return definition?.workflowType === 'flexible'
  }

  /**
   * Get raw workflow instance data (including instanceStates/instanceTransitions)
   */
  private static async getInstanceRaw(instanceId: string) {
    const results = await db
      .select()
      .from(workflowInstances)
      .where(eq(workflowInstances.id, instanceId))
      .limit(1)

    return results.length > 0 ? results[0] : null
  }

  /**
   * Check approval requirement for an instance-level transition
   * Now uses WorkflowApprovalService for real approval tracking
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
    const { WorkflowApprovalService } =
      await import('./WorkflowApprovalService')

    try {
      const status = await WorkflowApprovalService.areApprovalsComplete(
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
   */
  static async getAvailableTransitions(
    instanceId: string,
    context: GuardContext,
  ): Promise<Array<AvailableTransition>> {
    const instance = await this.getInstance(instanceId)
    if (!instance) {
      throw new NotFoundError('Workflow instance', instanceId)
    }

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
        const workflowTransition = transition as WorkflowTransition
        const guardResults = await GuardEvaluator.evaluateAll(
          workflowTransition.guards || [],
          context,
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

    return available
  }

  /**
   * Check if a specific transition is allowed
   */
  static async canTransition(
    instanceId: string,
    toStateId: string,
    context: GuardContext,
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
      .update(workflowInstances)
      .set({ releasingAt: new Date() })
      .where(
        and(
          eq(workflowInstances.id, instanceId),
          eq(workflowInstances.currentState, expectedState),
          isNull(workflowInstances.completedAt),
          or(
            isNull(workflowInstances.releasingAt),
            lt(workflowInstances.releasingAt, staleBefore),
          ),
        ),
      )
      .returning({ id: workflowInstances.id })

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
      .update(workflowInstances)
      .set({ releasingAt: null })
      .where(eq(workflowInstances.id, instanceId))
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
      .update(workflowInstances)
      .set({ currentState: stateId })
      .where(eq(workflowInstances.id, instanceId))

    await db.insert(workflowHistory).values({
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
        WorkflowService.RELEASE_CLAIM_TIMEOUT_MS
    ) {
      return {
        success: false,
        fromState: instance.currentState,
        toState: toStateId,
        error:
          'A release of this workflow is already in progress (claims expire after ' +
          `${WorkflowService.RELEASE_CLAIM_TIMEOUT_MS / 60_000} minutes if the releasing process dies)`,
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
      const workflowTransition = transition as WorkflowTransition

      // Build guard context
      const item = await this.getItemData(instance.itemId)
      const userRoles = await permissionService.getUserRoles(actorId)
      const context: GuardContext = {
        item: item || {},
        user: { id: actorId, roles: userRoles },
        workflowInstance: instance,
      }

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

    // Execute "before" actions (definition-level only)
    const beforeResults: Array<ActionResult> = []
    if (!effectiveStructure.isInstanceLevel) {
      const workflowTransition = transition as WorkflowTransition
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

    // Update workflow instance state. Compare-and-swap on the state we read:
    // if a concurrent transition won the race, this matches zero rows and we
    // abort with no writes instead of double-firing.
    const casRows = await db
      .update(workflowInstances)
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
          eq(workflowInstances.id, instanceId),
          eq(workflowInstances.currentState, instance.currentState),
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
                  isNull(workflowInstances.releasingAt),
                  lt(
                    workflowInstances.releasingAt,
                    new Date(
                      Date.now() - WorkflowService.RELEASE_CLAIM_TIMEOUT_MS,
                    ),
                  ),
                ),
              ]),
        ),
      )
      .returning({ id: workflowInstances.id })

    if (casRows.length === 0) {
      return {
        success: false,
        fromState: instance.currentState,
        toState: toStateId,
        guardResults,
        error:
          'Concurrent transition detected: the workflow changed state while this transition was being processed',
      }
    }

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
      const { WorkflowApprovalService } =
        await import('./WorkflowApprovalService')
      await WorkflowApprovalService.supersedeApprovalsForStates(instanceId, [
        toStateId,
        ...reachableFromTarget,
      ])
    }

    // Update the item's state to match (use state ID for consistency with service code)
    await db
      .update(items)
      .set({
        state: toStateId,
        modifiedAt: new Date(),
        modifiedBy: actorId,
      })
      .where(eq(items.id, instance.itemId))

    // Record history
    await db.insert(workflowHistory).values({
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

    // Execute "after" actions (definition-level only)
    const afterResults: Array<ActionResult> = []
    if (!effectiveStructure.isInstanceLevel) {
      const workflowTransition = transition as WorkflowTransition
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
    instance: WorkflowInstance,
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
    instance: WorkflowInstance,
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
    instance: WorkflowInstance,
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

  // ============================================
  // Helper Methods
  // ============================================

  /**
   * Map database result to WorkflowDefinition
   */
  private static mapToWorkflowDefinition(result: any): WorkflowDefinition {
    const def = result.definition

    // JSONB speaks first; the column only when the JSONB is silent — its
    // ADD-COLUMN default lied about legacy rows (normalize.ts has the rule)
    const lifecycleType = resolveStoredLifecycleType(result.lifecycleType, def)

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
}
