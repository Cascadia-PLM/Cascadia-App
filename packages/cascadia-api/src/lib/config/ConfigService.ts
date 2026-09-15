// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { resolveLifecycleType } from '@cascadia/commons/lib/lifecycles/normalize'
import { db } from '../db'
import { itemTypeConfigs, items } from '../db/schema'
import { notDeleted } from '../db/filters'
import { ConflictError, ValidationError } from '../errors'
import { ItemTypeRegistry } from '../items/registry'
import { LifecycleDefinitionService } from '../lifecycles/LifecycleDefinitionService'
import type { RuntimeItemTypeConfig } from '../db/schema'

const lifecyclesByChangeTypeSchema = z
  .object({
    ECO: z.string().uuid().optional(),
    ECN: z.string().uuid().optional(),
    Deviation: z.string().uuid().optional(),
    MCO: z.string().uuid().optional(),
    XCO: z.string().uuid().optional(),
  })
  .optional()

/**
 * Schema for validating runtime configuration updates
 */
const runtimeConfigSchema = z.object({
  /**
   * Links this item type to a lifecycle definition.
   * Must be a valid UUID referencing an active lifecycle in workflow_definitions.
   */
  lifecycleDefinitionId: z.string().uuid().optional().nullable(),
  /**
   * ChangeOrder only: the Driving definition each change type runs. Every
   * change type an install creates needs an entry; null is not a value.
   */
  lifecyclesByChangeType: lifecyclesByChangeTypeSchema,
  /**
   * The key the mapping shipped under, accepted for one release and moved
   * to `lifecyclesByChangeType` before anything is stored (CM-25).
   */
  workflowsByChangeType: lifecyclesByChangeTypeSchema,
})

/**
 * One key for the change-type mapping, whichever a row or a request carries.
 *
 * The mapping shipped as `workflowsByChangeType`; migration 0005 renames the
 * stored key and clients follow, but a row an older build wrote after the
 * migration, or a request from an older client, still says the old name for
 * one release. Applied on every read and every write, so nothing past this
 * service sees two spellings. The newer key wins where both appear.
 */
export function normalizeRuntimeConfig<T extends RuntimeItemTypeConfig>(
  config: T,
): T {
  if (config.workflowsByChangeType === undefined) return config
  const { workflowsByChangeType, ...rest } = config
  return {
    ...rest,
    lifecyclesByChangeType:
      config.lifecyclesByChangeType ?? workflowsByChangeType,
  } as T
}

/**
 * Result of lifecycle swap validation
 */
export interface LifecycleSwapValidation {
  valid: boolean
  errors: Array<string>
  currentLifecycleName?: string
  targetLifecycleName?: string
  statesNotInTarget: Array<{ state: string; itemCount: number }>
}

export interface ItemTypeConfigRecord {
  id: string
  itemType: string
  config: RuntimeItemTypeConfig
  version: number
  isActive: boolean
  modifiedBy: string
  modifiedAt: Date
  createdAt: Date
}

/**
 * Service for managing runtime item type configurations.
 * Handles CRUD operations for the item_type_configs table.
 */
export class ConfigService {
  /**
   * Get all active runtime configurations
   */
  static async getAllConfigs(): Promise<Array<ItemTypeConfigRecord>> {
    const configs = await db
      .select()
      .from(itemTypeConfigs)
      .where(eq(itemTypeConfigs.isActive, true))

    return configs.map((row) => ({
      ...row,
      config: normalizeRuntimeConfig(row.config),
    }))
  }

  /**
   * Get runtime configuration for a specific item type
   */
  static async getConfig(
    itemType: string,
  ): Promise<ItemTypeConfigRecord | null> {
    const result = await db
      .select()
      .from(itemTypeConfigs)
      .where(eq(itemTypeConfigs.itemType, itemType))
      .limit(1)

    const row = result[0]
    return row ? { ...row, config: normalizeRuntimeConfig(row.config) } : null
  }

  /**
   * Create or update runtime configuration for an item type.
   *
   * This is the only write path, and it validates rather than trusting its
   * caller: shape, the mandatory-lifecycle floor, and the lifecycle swap
   * itself. The swap check used to live in a `saveConfigWithLifecycleValidation`
   * wrapper that no route ever called, so the documented gate — an item type
   * may not be pointed at a lifecycle its items' states are missing from, nor
   * at a definition of the wrong kind — was bypassed by every real save.
   * Nothing needs to remember to opt in now; the current lifecycle comes from
   * the row being replaced.
   *
   * It also refreshes the registry, for the same reason: three route handlers
   * each remembered to call `reload()` afterwards, and the next writer would
   * not have.
   */
  static async saveConfig(
    itemType: string,
    config: RuntimeItemTypeConfig,
    userId: string,
  ): Promise<ItemTypeConfigRecord> {
    // Validate the config structure
    const parseResult = runtimeConfigSchema.safeParse(config)
    if (!parseResult.success) {
      throw ValidationError.fromZodError(parseResult.error, {
        operation: 'saveConfig',
        resource: `ItemTypeConfig:${itemType}`,
      })
    }

    // Every registered item type must keep a lifecycle: initial state,
    // released-family membership, and branch-protection scope all derive
    // from it, with no name-literal fallbacks anywhere. A config write is
    // the only way to unassign one, so this is where the floor is.
    if (
      ItemTypeRegistry.getType(itemType) &&
      !parseResult.data.lifecycleDefinitionId
    ) {
      throw new ValidationError(
        `Item type ${itemType} must have a lifecycle assigned; saving a config without lifecycleDefinitionId would leave it with none`,
        undefined,
        { operation: 'saveConfig', resource: `ItemTypeConfig:${itemType}` },
      )
    }

    const existing = await this.getConfig(itemType)
    const normalized = normalizeRuntimeConfig(
      parseResult.data as RuntimeItemTypeConfig,
    )

    const validation = await this.validateLifecycleSwap(
      itemType,
      existing?.config.lifecycleDefinitionId,
      normalized.lifecycleDefinitionId,
    )
    if (!validation.valid) {
      throw new ValidationError(validation.errors.join('; '), undefined, {
        operation: 'saveConfig',
        resource: `ItemTypeConfig:${itemType}`,
        details: {
          currentLifecycle: validation.currentLifecycleName,
          targetLifecycle: validation.targetLifecycleName,
          statesNotInTarget: validation.statesNotInTarget,
        },
      })
    }

    let result
    if (existing) {
      // Update existing config. Pinned to the version this call read, so two
      // administrators saving the same type at once is a conflict rather than
      // a silent last-writer-wins: the whole config document is replaced, so
      // the loser's edit would otherwise disappear without a trace.
      const updated = await db
        .update(itemTypeConfigs)
        .set({
          config: normalized,
          version: existing.version + 1,
          modifiedBy: userId,
          modifiedAt: new Date(),
        })
        .where(
          and(
            eq(itemTypeConfigs.itemType, itemType),
            eq(itemTypeConfigs.version, existing.version),
          ),
        )
        .returning()

      if (updated.length === 0) {
        throw new ConflictError(
          `The configuration for ${itemType} changed while you were editing it. Reload and reapply your change.`,
        )
      }

      result = updated[0]
    } else {
      // Insert new config
      const inserted = await db
        .insert(itemTypeConfigs)
        .values({
          itemType,
          config: normalized,
          modifiedBy: userId,
        })
        .returning()

      result = inserted[0]
    }

    // The registry serves `lifecycleDefinitionId` from a process-local cache;
    // a write nothing reloads is invisible to this process until restart.
    await ItemTypeRegistry.reload()

    return result as ItemTypeConfigRecord
  }

  // `deleteConfig`, `deactivateConfig` and `activateConfig` are gone with the
  // DELETE route that was their only caller. Deleting a registered type's row
  // would drop the lifecycle assignment every item type is required to have,
  // so the delete could only refuse; the two soft-delete methods had never had
  // a caller at all.

  // ============================================
  // Lifecycle Validation Methods
  // ============================================

  /**
   * The kind of definition this item type's *code* definition assigns, or
   * null when it has none or the row is missing.
   *
   * Read from the code definition rather than the merged one on purpose: the
   * merged value is what a previous runtime save set, so validating against
   * it would let a type drift one save at a time.
   */
  private static async governingKindFromCode(
    itemType: string,
  ): Promise<'Driven' | 'Driving' | 'Free' | null> {
    const codeLifecycleId =
      ItemTypeRegistry.getCodeDefinition(itemType)?.lifecycleDefinitionId
    if (!codeLifecycleId) return null
    const definition = await LifecycleDefinitionService.getById(codeLifecycleId)
    return definition ? resolveLifecycleType(definition) : null
  }

  /**
   * Validate that a lifecycle can be assigned to an item type.
   * Checks that all items of this type have states that exist in the target lifecycle.
   *
   * @param itemType - The item type being updated
   * @param currentLifecycleId - The current lifecycle ID (null if none)
   * @param targetLifecycleId - The new lifecycle ID to assign
   * @returns Validation result with any errors
   */
  static async validateLifecycleSwap(
    itemType: string,
    currentLifecycleId: string | null | undefined,
    targetLifecycleId: string | null | undefined,
  ): Promise<LifecycleSwapValidation> {
    // No change - always valid
    if (currentLifecycleId === targetLifecycleId) {
      return { valid: true, errors: [], statesNotInTarget: [] }
    }

    // Removing lifecycle (setting to null) - always valid
    if (!targetLifecycleId) {
      return { valid: true, errors: [], statesNotInTarget: [] }
    }

    // Validate target lifecycle exists and is a lifecycle type
    const targetLifecycle =
      await LifecycleDefinitionService.getById(targetLifecycleId)
    if (!targetLifecycle) {
      return {
        valid: false,
        errors: [`Lifecycle '${targetLifecycleId}' not found`],
        statesNotInTarget: [],
      }
    }

    // A swap may change which definition governs a type; it may not change
    // what *kind* governs it. The kind is what branch protection reads:
    // `isBranchProtectionExempt` exempts Free and Driving, so pointing Part
    // at a change-order workflow would take every Part out of the ECO
    // machinery and let it be written straight to a protected main. The
    // converse matters too — a ChangeOrder pointed at an item lifecycle has
    // no change-action mappings and stops driving anything.
    //
    // The reference kind is the one the type's code definition carries, which
    // is why this is not a blanket "no Driving": ChangeOrder is Driving-
    // governed by design, and the gate that rejected every Driving target
    // would have rejected its own shipped configuration.
    const expectedKind = await this.governingKindFromCode(itemType)
    const targetKind = resolveLifecycleType(targetLifecycle)
    const targetIsDriving = targetKind === 'Driving'

    if (
      expectedKind !== null &&
      targetIsDriving !== (expectedKind === 'Driving')
    ) {
      return {
        valid: false,
        errors: [
          targetIsDriving
            ? `'${targetLifecycle.name}' is a change-order workflow, not an item lifecycle: assigning it to ${itemType} would exempt every ${itemType} from branch protection`
            : `'${targetLifecycle.name}' is an item lifecycle, not a change-order workflow, and ${itemType} is governed by a workflow`,
        ],
        statesNotInTarget: [],
        targetLifecycleName: targetLifecycle.name,
      }
    }

    // A Driving-governed type's items do not all run the type-level
    // definition — a change order runs whichever definition its change type
    // maps to (`lifecyclesByChangeType`) — so their states are not this
    // definition's to account for, and checking them would reject a valid
    // save the moment one change order had run the flexible workflow.
    if (targetIsDriving) {
      return {
        valid: true,
        errors: [],
        targetLifecycleName: targetLifecycle.name,
        statesNotInTarget: [],
      }
    }

    // Get valid state IDs from target lifecycle
    const validStateIds = new Set(targetLifecycle.states.map((s) => s.id))
    const validStateNames = new Set(targetLifecycle.states.map((s) => s.name))

    // Get current items and their states for this item type
    const stateCountsResult = await db
      .select({
        state: items.state,
        count: sql<number>`count(*)::int`,
      })
      .from(items)
      .where(and(eq(items.itemType, itemType), notDeleted()))
      .groupBy(items.state)

    // Check which states are not in target lifecycle
    const statesNotInTarget: Array<{ state: string; itemCount: number }> = []
    for (const row of stateCountsResult) {
      const state = row.state
      if (!state) continue

      // Check both state ID and name for compatibility
      if (!validStateIds.has(state) && !validStateNames.has(state)) {
        statesNotInTarget.push({
          state,
          itemCount: row.count,
        })
      }
    }

    if (statesNotInTarget.length > 0) {
      const errorDetails = statesNotInTarget
        .map((s) => `'${s.state}' (${s.itemCount} items)`)
        .join(', ')

      return {
        valid: false,
        errors: [
          `Cannot assign lifecycle '${targetLifecycle.name}' to ${itemType}: ` +
            `${statesNotInTarget.reduce((sum, s) => sum + s.itemCount, 0)} items are in states ` +
            `not defined in this lifecycle: ${errorDetails}`,
        ],
        targetLifecycleName: targetLifecycle.name,
        statesNotInTarget,
      }
    }

    // Get current lifecycle name for logging (if exists)
    let currentLifecycleName: string | undefined
    if (currentLifecycleId) {
      const currentLifecycle =
        await LifecycleDefinitionService.getById(currentLifecycleId)
      currentLifecycleName = currentLifecycle?.name
    }

    return {
      valid: true,
      errors: [],
      currentLifecycleName,
      targetLifecycleName: targetLifecycle.name,
      statesNotInTarget: [],
    }
  }
}
