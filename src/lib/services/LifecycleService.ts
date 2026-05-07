// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

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
    // add and remove don't affect state - no mapping needed
    if (action === 'add' || action === 'remove') {
      return null
    }

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
  ): Promise<ActionValidationResult> {
    // add and remove don't affect state - always valid
    if (action === 'add' || action === 'remove') {
      return { valid: true }
    }

    const mapping = await this.getActionMapping(itemType, action)

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
      const lifecycle = await this.getLifecycleForItemType(itemType)
      if (lifecycle?.phases && lifecycle.phases.length > 0) {
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
    const validActions: Array<ChangeAction> = ['add', 'remove'] // Always valid (membership actions)

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
    if (action === 'add' || action === 'remove') {
      return null // No state change
    }

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
    if (action === 'add' || action === 'remove') {
      return false
    }

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
   * Get the initial state for a new item of this type.
   * Returns the state marked as isInitial in the lifecycle definition.
   *
   * @param itemType - The type of item
   * @returns The initial state name, or 'Draft' as fallback
   */
  static async getInitialState(itemType: string): Promise<string> {
    const lifecycle = await ItemTypeRegistry.getLifecycleForType(itemType)

    if (lifecycle) {
      const initialState = lifecycle.states.find((s) => s.isInitial)
      if (initialState) {
        return initialState.name
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

    const states = lifecycle.states
    const state = states.find((s) => s.id === stateId || s.name === stateId)
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

    if (lifecycle) {
      // New unified model: use lifecycleType field
      if ((lifecycle as any).lifecycleType) {
        return (lifecycle as any).lifecycleType as LifecycleType
      }

      // Legacy fallback: infer from definitionType
      if (lifecycle.definitionType === 'lifecycle') {
        return 'Driven' // Old lifecycles are Driven (controlled by ECOs)
      }
      return 'Driving' // Old workflows are Driving (ECOs)
    }

    // Default fallback
    return 'Free'
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
   * Get all valid target states for a Driven lifecycle.
   * For Driven lifecycles, all non-initial states are valid targets.
   *
   * @param drivenLifecycleId - The ID of the Driven lifecycle
   * @returns Array of valid target states
   */
  static async getValidTargetStates(
    drivenLifecycleId: string,
  ): Promise<Array<WorkflowState>> {
    const result = await db
      .select({
        definition: workflowDefinitions.definition,
      })
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, drivenLifecycleId))
      .limit(1)

    const row = result.at(0)
    if (!row?.definition) {
      return []
    }

    const def = row.definition as { states?: Array<WorkflowState> }
    if (!def.states) {
      return []
    }

    // For Driven lifecycles, all states except Initial are valid targets
    // Initial state is where items start; ECOs move them to other states
    return def.states.filter((s) => !s.isInitial)
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

    // Determine lifecycle type
    let lifecycleType: LifecycleType = 'Free'
    if (row.lifecycleType) {
      lifecycleType = row.lifecycleType as LifecycleType
    } else if (def.lifecycleType) {
      lifecycleType = def.lifecycleType
    } else if (def.definitionType === 'lifecycle') {
      lifecycleType = 'Driven'
    } else if (def.definitionType === 'workflow') {
      lifecycleType = 'Driving'
    }

    return {
      id: row.id,
      name: row.name,
      lifecycleType,
      states: def.states ?? [],
      drivers: row.drivers ?? [],
    }
  }
}
