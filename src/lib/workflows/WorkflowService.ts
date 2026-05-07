// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db'
import {
  workflowDefinitions,
  workflowHistory,
  workflowInstances,
} from '../db/schema/workflows'
import { items } from '../db/schema/items'
import { ItemTypeRegistry } from '../items/registry'
import { permissionService } from '../auth/permission-service'
import { GuardEvaluator } from './GuardEvaluator'
import type {
  ActionResult,
  ApprovalRequirement,
  AvailableTransition,
  ChangeAction,
  CreateWorkflowInput,
  EffectiveWorkflowStructure,
  GuardContext,
  GuardResult,
  InstanceWorkflowTransition,
  LifecycleEffect,
  LifecycleEffectResult,
  SendNotificationConfig,
  TransitionAction,
  TransitionDrivenItemConfig,
  TransitionResult,
  UpdateWorkflowInput,
  ValidationError,
  ValidationResult,
  ValidationWarning,
  WorkflowDefinition,
  WorkflowHistoryEntry,
  WorkflowInstance,
  WorkflowState,
  WorkflowTransition,
} from './types'

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
      throw new Error(
        `Invalid workflow definition: ${validation.errors.map((e) => e.message).join(', ')}`,
      )
    }

    // Determine lifecycle type
    let lifecycleType = input.lifecycleType
    if (!lifecycleType) {
      // Legacy fallback: infer from definitionType
      if (input.definitionType === 'lifecycle') {
        lifecycleType = 'Driven'
      } else {
        lifecycleType = 'Driving'
      }
    }

    const definition = {
      states: input.states,
      transitions: input.transitions,
      definitionType: input.definitionType,
      description: input.description,
      applicableItemTypes: input.applicableItemTypes,
      changeActionMappings: input.changeActionMappings,
      lifecycleType, // Also store in definition for compatibility
      revisionScheme: input.revisionScheme,
      phases: input.phases,
    }

    const [result] = await db
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
      .returning()

    return this.mapToWorkflowDefinition(result)
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
    definitionType?: 'lifecycle' | 'workflow'
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

    // Filter by definitionType in memory since it's stored in JSONB
    let definitions = results.map((r) => this.mapToWorkflowDefinition(r))

    if (filters?.definitionType) {
      definitions = definitions.filter(
        (d) => d.definitionType === filters.definitionType,
      )
    }

    return definitions
  }

  /**
   * Update a workflow definition
   */
  static async update(
    id: string,
    input: UpdateWorkflowInput,
  ): Promise<WorkflowDefinition> {
    const existing = await this.getById(id)
    if (!existing) {
      throw new Error('Workflow definition not found')
    }

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
      throw new Error(
        `Invalid workflow definition: ${validation.errors.map((e) => e.message).join(', ')}`,
      )
    }

    // For lifecycles, validate that removed states don't have items in them
    if (existing.definitionType === 'lifecycle' && input.states) {
      const stateValidation = await this.validateStateRemoval(
        id,
        existing.states,
        input.states,
      )
      if (!stateValidation.valid) {
        throw new Error(stateValidation.errors.join('; '))
      }
    }

    // Determine lifecycle type
    const lifecycleType = input.lifecycleType ?? existing.lifecycleType

    const definition = {
      states: updated.states,
      transitions: updated.transitions,
      definitionType: updated.definitionType,
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

    return this.mapToWorkflowDefinition(result)
  }

  /**
   * Delete a workflow definition
   */
  static async delete(id: string): Promise<void> {
    const existing = await this.getById(id)
    if (!existing) {
      throw new Error('Workflow definition not found')
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
      throw new Error('Cannot delete workflow with active instances')
    }

    // For lifecycles, check if any item types are using this lifecycle
    if (existing.definitionType === 'lifecycle') {
      const itemTypesUsingLifecycle =
        ItemTypeRegistry.getItemTypesUsingLifecycle(id)
      if (itemTypesUsingLifecycle.length > 0) {
        throw new Error(
          `Cannot delete lifecycle '${existing.name}': ` +
            `It is assigned to item types: ${itemTypesUsingLifecycle.join(', ')}. ` +
            `Remove the lifecycle assignment from these item types first.`,
        )
      }
    }

    await db.delete(workflowDefinitions).where(eq(workflowDefinitions.id, id))
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
    const errors: Array<ValidationError> = []
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

      // Validate promote mapping crosses phase boundaries
      if (definition.changeActionMappings?.promote && definition.states) {
        const promoteMapping = definition.changeActionMappings.promote
        const fromState = definition.states.find(
          (s) =>
            s.id === promoteMapping.fromState ||
            s.name === promoteMapping.fromState,
        )
        const toState = definition.states.find(
          (s) =>
            s.id === promoteMapping.toState ||
            s.name === promoteMapping.toState,
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
    // Find states that are being removed
    const newStateIds = new Set(newStates.map((s) => s.id))
    const newStateNames = new Set(newStates.map((s) => s.name))
    const removedStates = currentStates.filter(
      (s) => !newStateIds.has(s.id) && !newStateNames.has(s.name),
    )

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

    // Check if any items are in the states being removed
    const removedStateIdentifiers = removedStates.flatMap((s) => [s.id, s.name])
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
          inArray(items.state, removedStateIdentifiers),
          eq(items.isDeleted, false),
        ),
      )
      .groupBy(items.state, items.itemType)

    for (const row of itemCounts) {
      if (row.count > 0) {
        const state = removedStates.find(
          (s) => s.id === row.state || s.name === row.state,
        )
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
      throw new Error('Workflow definition not found')
    }

    const initialState = definition.states.find((s) => s.isInitial)
    if (!initialState) {
      throw new Error('Workflow has no initial state')
    }

    // For flexible workflows, copy the structure to the instance
    const isFlexible = definition.workflowType === 'flexible'

    const [instance] = await db
      .insert(workflowInstances)
      .values({
        workflowDefinitionId,
        itemId,
        currentState: initialState.id,
        context: context || {},
        // Initialize instance structure for flexible workflows
        instanceStates: isFlexible ? definition.states : null,
        instanceTransitions: isFlexible ? (definition.transitions ?? []) : null,
      })
      .returning()

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

    if (results.length === 0) return null
    const result = results[0]
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

    if (instanceResults.length === 0) return null
    const result = instanceResults[0]
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
      throw new Error('Workflow instance not found')
    }

    const definition = await this.getById(instance.workflowDefinitionId!)
    if (!definition) {
      throw new Error('Workflow definition not found')
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
    _requirement: ApprovalRequirement,
  ): Promise<{ met: boolean; required: number; current: number }> {
    const { WorkflowApprovalService } =
      await import('./WorkflowApprovalService')

    try {
      const status = await WorkflowApprovalService.areApprovalsComplete(
        instanceId,
        stateId,
      )

      return {
        met: status.met,
        required: status.required,
        current: status.current,
      }
    } catch {
      // If there's an error checking approvals, be conservative
      // and allow transition only if no approvers are configured
      return {
        met: _requirement.requiredCount === 0,
        required: _requirement.requiredCount || 0,
        current: 0,
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
      throw new Error('Workflow instance not found')
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
        const instanceTransition = transition as InstanceWorkflowTransition

        // Check approvals for the current state (fromStateId)
        const approvalResult = await this.checkApprovalRequirement(
          instanceId,
          transition.fromStateId,
          instanceTransition.approvalRequirement || { requiredCount: 0 },
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
          transition: transition as WorkflowTransition,
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

        // Also check state-level approvers
        const approvalResult = await this.checkApprovalRequirement(
          instanceId,
          transition.fromStateId,
          { requiredCount: 0 },
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
   * Execute a transition
   * Uses effective structure for flexible workflows
   */
  static async transition(
    instanceId: string,
    toStateId: string,
    actorId: string,
    comments?: string,
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
      // Check approvals for the current state (fromStateId)
      const approvalResult = await this.checkApprovalRequirement(
        instanceId,
        instance.currentState,
        { requiredCount: 0 },
      )
      if (!approvalResult.met) {
        return {
          success: false,
          fromState: instance.currentState,
          toState: toStateId,
          error: `Approval requirement not met: ${approvalResult.current}/${approvalResult.required}`,
          guardResults: [
            {
              guardId: 'approval-requirement',
              guardName: 'Approval Requirement',
              passed: false,
              errorMessage: `Requires ${approvalResult.required} approvals`,
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

      // Check state-level approvers
      const approvalResult = await this.checkApprovalRequirement(
        instanceId,
        instance.currentState,
        { requiredCount: 0 },
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
              errorMessage: `Requires ${approvalResult.required} approvals, has ${approvalResult.current}`,
            },
          ],
          error: `State approval requirement not met: ${approvalResult.current}/${approvalResult.required}`,
        }
      }

      // Validate lifecycle effects guards (for definition-level workflows only)
      if (
        effectiveStructure.definition.definitionType === 'workflow' &&
        workflowTransition.lifecycleEffects?.length
      ) {
        const lifecycleValidation = await this.validateLifecycleEffectsGuards(
          workflowTransition,
          instance.itemId, // The change order ID
          actorId,
        )

        if (!lifecycleValidation.valid) {
          return {
            success: false,
            fromState: instance.currentState,
            toState: toStateId,
            guardResults,
            error: `Lifecycle effects validation failed: ${lifecycleValidation.errors.join('; ')}`,
          }
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
        const result = await this.executeAction(action, instance, actorId)
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
    const shouldLockScope =
      effectiveStructure.definition.lifecycleType === 'Driving' &&
      currentStateObj?.isInitial &&
      !instance.scopeLocked

    // Update workflow instance state
    await db
      .update(workflowInstances)
      .set({
        currentState: toStateId,
        completedAt: isComplete ? new Date() : null,
        // Lock scope when leaving initial state on Driving lifecycles
        ...(shouldLockScope && {
          scopeLocked: true,
          scopeLockedAt: new Date(),
        }),
      })
      .where(eq(workflowInstances.id, instanceId))

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
        )
        afterResults.push(result)
        // Note: We don't fail the transition for after-action failures
      }
    }

    // Execute lifecycle effects (for definition-level workflows only)
    let lifecycleEffectResults: Array<LifecycleEffectResult> = []
    if (!effectiveStructure.isInstanceLevel) {
      const workflowTransition = transition as WorkflowTransition
      if (
        effectiveStructure.definition.definitionType === 'workflow' &&
        workflowTransition.lifecycleEffects?.length
      ) {
        const effectsResult = await this.executeLifecycleEffects(
          workflowTransition,
          instance.itemId, // The change order ID
          actorId,
        )
        lifecycleEffectResults = effectsResult.results
        // Note: We don't fail the transition for lifecycle effect failures
        // (guards were already validated, failures here are unexpected)
      }
    }

    return {
      success: true,
      fromState: instance.currentState,
      toState: toStateId,
      guardResults,
      actionResults: [...beforeResults, ...afterResults],
      lifecycleEffectResults,
    }
  }

  // ============================================
  // Lifecycle Validation (for Parts, Documents, etc.)
  // ============================================

  /**
   * Validate if a lifecycle transition is allowed for an item
   */
  static async validateLifecycleTransition(
    lifecycleDefinitionId: string,
    fromState: string,
    toState: string,
    itemData: Record<string, unknown>,
    userId: string,
  ): Promise<{ valid: boolean; errors: Array<string> }> {
    const definition = await this.getById(lifecycleDefinitionId)

    if (!definition) {
      return {
        valid: false,
        errors: [`Lifecycle definition '${lifecycleDefinitionId}' not found`],
      }
    }

    if (definition.definitionType !== 'lifecycle') {
      return {
        valid: false,
        errors: [
          `Definition '${definition.name}' is a workflow, not a lifecycle`,
        ],
      }
    }

    // Find the transition
    const transition = (definition.transitions ?? []).find(
      (t) => t.fromStateId === fromState && t.toStateId === toState,
    )

    if (!transition) {
      return {
        valid: false,
        errors: [
          `Lifecycle '${definition.name}' does not allow transition from '${fromState}' to '${toState}'`,
        ],
      }
    }

    // Evaluate guards
    const userRoles = await permissionService.getUserRoles(userId)
    const context: GuardContext = {
      item: itemData,
      user: { id: userId, roles: userRoles },
    }

    const guardResults = await GuardEvaluator.evaluateAll(
      transition.guards || [],
      context,
    )
    const failedGuards = guardResults.filter((r) => !r.passed)

    if (failedGuards.length > 0) {
      return {
        valid: false,
        errors: failedGuards.map(
          (g) => g.errorMessage || `Guard "${g.guardName}" failed`,
        ),
      }
    }

    return { valid: true, errors: [] }
  }

  // ============================================
  // Lifecycle Effects (ECO-to-Item Coordination)
  // ============================================

  /**
   * Validate lifecycle effects guards before a workflow transition can proceed
   * Returns errors if any affected item's lifecycle guards fail
   */
  static async validateLifecycleEffectsGuards(
    transition: WorkflowTransition,
    changeOrderId: string,
    actorId: string,
  ): Promise<{ valid: boolean; errors: Array<string> }> {
    const { ChangeOrderService } =
      await import('../items/services/ChangeOrderService')
    const effects = transition.lifecycleEffects || []

    // Filter to effects that require guard validation
    const effectsWithGuards = effects.filter((e) => e.validateGuards)
    if (effectsWithGuards.length === 0) {
      return { valid: true, errors: [] }
    }

    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)
    const errors: Array<string> = []

    for (const affected of affectedItems) {
      if (!affected.affectedItemId) continue

      // Get item details from the joined data
      const item = affected.affectedItemDetails
      if (!item) continue

      // Get lifecycle ID from ItemTypeRegistry based on item type
      const lifecycleDefinitionId = item.itemType
        ? ItemTypeRegistry.getLifecycleDefinitionId(item.itemType)
        : undefined

      // Build the chain of effects for this item
      const chain = this.buildEffectChain(
        effectsWithGuards,
        affected.changeAction as ChangeAction,
        item.state || '',
        lifecycleDefinitionId,
      )

      // Validate guards for each effect in the chain
      for (const effect of chain) {
        const lifecycle = await this.getById(effect.lifecycleDefinitionId)
        if (!lifecycle) continue

        const lifecycleTransition = (lifecycle.transitions ?? []).find(
          (t) =>
            t.fromStateId === effect.fromStateId &&
            t.toStateId === effect.toStateId,
        )

        if (!lifecycleTransition) continue

        // Evaluate guards
        const actorRoles = await permissionService.getUserRoles(actorId)
        const context: GuardContext = {
          item: item as Record<string, unknown>,
          user: { id: actorId, roles: actorRoles },
        }

        const guardResults = await GuardEvaluator.evaluateAll(
          lifecycleTransition.guards || [],
          context,
        )
        const failedGuards = guardResults.filter((r) => !r.passed)

        if (failedGuards.length > 0) {
          const itemRef = item.itemNumber || affected.affectedItemId
          for (const guard of failedGuards) {
            errors.push(
              `${itemRef}: ${guard.errorMessage || `Guard "${guard.guardName}" failed`} (lifecycle: ${lifecycle.name})`,
            )
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    }
  }

  /**
   * Execute lifecycle effects for affected items when a workflow transition occurs
   * Supports chained effects (e.g., Preliminary → Under Review → Released)
   */
  static async executeLifecycleEffects(
    transition: WorkflowTransition,
    changeOrderId: string,
    actorId: string,
  ): Promise<{ success: boolean; results: Array<LifecycleEffectResult> }> {
    const { ChangeOrderService } =
      await import('../items/services/ChangeOrderService')
    const effects = transition.lifecycleEffects || []

    if (effects.length === 0) {
      return { success: true, results: [] }
    }

    const affectedItems =
      await ChangeOrderService.getAffectedItems(changeOrderId)
    const results: Array<LifecycleEffectResult> = []

    for (const affected of affectedItems) {
      if (!affected.affectedItemId) continue

      const item = affected.affectedItemDetails
      if (!item) {
        results.push({
          itemId: affected.affectedItemId,
          changeAction: affected.changeAction as ChangeAction,
          executedTransitions: [],
          success: false,
          error: 'Item data not found',
        })
        continue
      }

      // Get lifecycle ID from ItemTypeRegistry based on item type
      const lifecycleDefinitionId = item.itemType
        ? ItemTypeRegistry.getLifecycleDefinitionId(item.itemType)
        : undefined

      // Build the chain of effects for this item
      const chain = this.buildEffectChain(
        effects,
        affected.changeAction as ChangeAction,
        item.state || '',
        lifecycleDefinitionId,
      )

      if (chain.length === 0) {
        // No effects apply to this item - skip it (not an error)
        continue
      }

      const result: LifecycleEffectResult = {
        itemId: affected.affectedItemId,
        itemNumber: item.itemNumber,
        changeAction: affected.changeAction as ChangeAction,
        executedTransitions: [],
        success: true,
      }

      // Execute each effect in the chain
      let currentState = item.state || ''
      for (const effect of chain) {
        try {
          // Update the item's state
          await db
            .update(items)
            .set({
              state: effect.toStateId,
              modifiedAt: new Date(),
              modifiedBy: actorId,
            })
            .where(eq(items.id, affected.affectedItemId))

          result.executedTransitions.push({
            fromState: currentState,
            toState: effect.toStateId,
            success: true,
          })

          currentState = effect.toStateId
        } catch (err) {
          result.executedTransitions.push({
            fromState: currentState,
            toState: effect.toStateId,
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          })
          result.success = false
          result.error = `Failed to transition from ${currentState} to ${effect.toStateId}`
          break // Stop chain on failure
        }
      }

      results.push(result)
    }

    const overallSuccess = results.every((r) => r.success)
    return { success: overallSuccess, results }
  }

  /**
   * Build a chain of lifecycle effects starting from an item's current state
   * Returns effects in execution order (handles effects defined out of order)
   */
  private static buildEffectChain(
    effects: Array<LifecycleEffect>,
    changeAction: ChangeAction,
    currentState: string,
    lifecycleDefinitionId?: string,
  ): Array<LifecycleEffect> {
    // Filter effects by change action and lifecycle
    const relevantEffects = effects.filter((e) => {
      if (e.changeAction !== changeAction) return false
      // If item has a lifecycle assigned, only use effects for that lifecycle
      if (
        lifecycleDefinitionId &&
        e.lifecycleDefinitionId !== lifecycleDefinitionId
      )
        return false
      return true
    })

    if (relevantEffects.length === 0) return []

    // Build chain starting from current state
    const chain: Array<LifecycleEffect> = []
    let state = currentState

    for (;;) {
      const nextEffect = relevantEffects.find((e) => e.fromStateId === state)
      if (!nextEffect) break

      // Check for circular reference
      if (chain.some((e) => e.id === nextEffect.id)) break

      chain.push(nextEffect)
      state = nextEffect.toStateId
    }

    return chain
  }

  // ============================================
  // Action Execution
  // ============================================

  /**
   * Execute a transition action
   */
  private static async executeAction(
    action: TransitionAction,
    instance: WorkflowInstance,
    actorId: string,
  ): Promise<ActionResult> {
    try {
      switch (action.type) {
        case 'update_field':
          return await this.executeUpdateField(action, instance, actorId)

        case 'send_notification':
          return await this.executeSendNotification(action, instance, actorId)

        case 'create_task': {
          const { NotImplementedError } = await import('../errors')
          throw new NotImplementedError(
            'create_task workflow action is not yet implemented',
          )
        }

        case 'transition_driven_item':
          return await this.executeTransitionDrivenItem(
            action,
            instance,
            actorId,
          )

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
   * Execute TransitionDrivenItem action
   * Transitions affected items on their Driven lifecycles to the target state
   */
  private static async executeTransitionDrivenItem(
    action: TransitionAction,
    instance: WorkflowInstance,
    actorId: string,
  ): Promise<ActionResult> {
    const { ChangeOrderService } =
      await import('../items/services/ChangeOrderService')

    try {
      const config = action.config as TransitionDrivenItemConfig
      if (!config.targetStateId) {
        return {
          actionId: action.id,
          actionName: action.name,
          success: false,
          error: 'TransitionDrivenItem action requires targetStateId',
        }
      }

      // Get affected items for this change order
      const changeOrderId = instance.itemId
      const affectedItems =
        await ChangeOrderService.getAffectedItems(changeOrderId)

      if (affectedItems.length === 0) {
        // No affected items, nothing to do
        return {
          actionId: action.id,
          actionName: action.name,
          success: true,
          data: { transitionedCount: 0 },
        }
      }

      let transitionedCount = 0
      const errors: Array<string> = []

      // Pre-fetch lifecycle and actor roles if gate validation is needed
      let drivenLifecycle: WorkflowDefinition | null = null
      let actorRoles: Array<string> = []
      if (config.validateGates) {
        drivenLifecycle = await this.getById(config.drivenLifecycleId)
        actorRoles = await permissionService.getUserRoles(actorId)
      }

      for (const affected of affectedItems) {
        if (!affected.affectedItemId) continue

        const item = affected.affectedItemDetails
        if (!item) continue

        // Apply filter if specified
        if (config.filter?.itemTypes?.length) {
          if (!config.filter.itemTypes.includes(item.itemType)) {
            continue // Skip items not matching type filter
          }
        }
        if (config.filter?.currentStates?.length) {
          if (!config.filter.currentStates.includes(item.state || '')) {
            continue // Skip items not matching state filter
          }
        }

        // Validate destination state gates if configured
        if (config.validateGates && drivenLifecycle) {
          const lifecycleTransition = (drivenLifecycle.transitions ?? []).find(
            (t) =>
              t.fromStateId === config.fromStateId &&
              t.toStateId === config.targetStateId,
          )

          if (lifecycleTransition?.guards?.length) {
            const guardContext: GuardContext = {
              item: item as Record<string, unknown>,
              user: { id: actorId, roles: actorRoles },
            }

            const guardResults = GuardEvaluator.evaluateAll(
              lifecycleTransition.guards,
              guardContext,
            )
            const failedGuards = guardResults.filter((r) => !r.passed)

            if (failedGuards.length > 0) {
              const itemRef = item.itemNumber || affected.affectedItemId
              for (const guard of failedGuards) {
                errors.push(
                  `${itemRef}: ${guard.errorMessage || `Guard "${guard.guardName}" failed`}`,
                )
              }
              continue
            }
          }
        }

        // Update the item's state
        try {
          await db
            .update(items)
            .set({
              state: config.targetStateId,
              modifiedAt: new Date(),
              modifiedBy: actorId,
            })
            .where(eq(items.id, affected.affectedItemId))

          transitionedCount++
        } catch (err) {
          errors.push(
            `Failed to transition ${item.itemNumber}: ${err instanceof Error ? err.message : 'Unknown error'}`,
          )
        }
      }

      if (errors.length > 0) {
        return {
          actionId: action.id,
          actionName: action.name,
          success: false,
          error: errors.join('; '),
          data: { transitionedCount, errors },
        }
      }

      return {
        actionId: action.id,
        actionName: action.name,
        success: true,
        data: { transitionedCount },
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
    const config = action.config as { fieldName: string; value: unknown }

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

      // Get the workflow definition and latest history entry for transition details
      const definition = await this.getById(instance.workflowDefinitionId)

      // Get the most recent history entry to get accurate from/to states
      // (for "after" actions, history is already recorded with correct states)
      const history = await this.getHistory(instance.id)
      const latestEntry = history[0] // Most recent is first (ordered by desc)

      const fromStateName =
        definition?.states.find((s) => s.id === latestEntry.fromState)?.name ??
        latestEntry.fromState
      const toStateName =
        definition?.states.find((s) => s.id === latestEntry.toState)?.name ??
        latestEntry.toState

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

    // Determine lifecycleType from database column or definition
    let lifecycleType = result.lifecycleType ?? def.lifecycleType
    if (!lifecycleType) {
      // Legacy fallback: infer from definitionType
      if (def.definitionType === 'lifecycle') {
        lifecycleType = 'Driven'
      } else if (def.definitionType === 'workflow') {
        lifecycleType = 'Driving'
      } else {
        lifecycleType = 'Free'
      }
    }

    return {
      id: result.id,
      name: result.name,
      version: result.version,
      definitionType: def.definitionType || 'workflow',
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
