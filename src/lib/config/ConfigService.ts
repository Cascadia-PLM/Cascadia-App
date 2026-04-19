import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db'
import { itemTypeConfigs, items } from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import { WorkflowService } from '../workflows/WorkflowService'
import type { RuntimeItemTypeConfig } from '../db/schema'

/**
 * Schema for validating runtime configuration updates
 */
const runtimeConfigSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  pluralLabel: z.string().min(1).max(100).optional(),
  icon: z.string().min(1).max(50).optional(),
  /**
   * Links this item type to a lifecycle definition.
   * Must be a valid UUID referencing an active lifecycle in workflow_definitions.
   */
  lifecycleDefinitionId: z.string().uuid().optional().nullable(),
  permissions: z
    .object({
      create: z.array(z.string()),
      read: z.array(z.string()),
      update: z.array(z.string()),
      delete: z.array(z.string()),
    })
    .optional(),
  relationships: z
    .array(
      z.object({
        type: z.string().min(1),
        label: z.string().min(1),
        targetTypes: z.array(z.string()),
        allowMultiple: z.boolean(),
      }),
    )
    .optional(),
  fieldMetadata: z.record(z.string(), z.unknown()).optional(),
  /**
   * For ChangeOrder item type only: Maps change order types to workflow definition UUIDs.
   * All change types must have a workflow assigned - null values are not allowed.
   */
  workflowsByChangeType: z
    .object({
      ECO: z.string().uuid().optional(),
      ECN: z.string().uuid().optional(),
      Deviation: z.string().uuid().optional(),
      MCO: z.string().uuid().optional(),
    })
    .optional(),
})

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

    return configs as Array<ItemTypeConfigRecord>
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

    return result[0] ? (result[0] as ItemTypeConfigRecord) : null
  }

  /**
   * Create or update runtime configuration for an item type
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

    const existing = await this.getConfig(itemType)

    let result
    if (existing) {
      // Update existing config
      const updated = await db
        .update(itemTypeConfigs)
        .set({
          config: parseResult.data as RuntimeItemTypeConfig,
          version: existing.version + 1,
          modifiedBy: userId,
          modifiedAt: new Date(),
        })
        .where(eq(itemTypeConfigs.itemType, itemType))
        .returning()

      result = updated[0]
    } else {
      // Insert new config
      const inserted = await db
        .insert(itemTypeConfigs)
        .values({
          itemType,
          config: parseResult.data as RuntimeItemTypeConfig,
          modifiedBy: userId,
        })
        .returning()

      result = inserted[0]
    }

    return result as ItemTypeConfigRecord
  }

  /**
   * Delete runtime configuration for an item type (reverts to code defaults)
   */
  static async deleteConfig(itemType: string): Promise<boolean> {
    const result = await db
      .delete(itemTypeConfigs)
      .where(eq(itemTypeConfigs.itemType, itemType))
      .returning()

    if (result.length === 0) {
      throw new NotFoundError('ItemTypeConfig', itemType, {
        operation: 'delete',
      })
    }

    return true
  }

  /**
   * Deactivate a configuration without deleting it (soft delete)
   */
  static async deactivateConfig(
    itemType: string,
    userId: string,
  ): Promise<ItemTypeConfigRecord> {
    const result = await db
      .update(itemTypeConfigs)
      .set({
        isActive: false,
        modifiedBy: userId,
        modifiedAt: new Date(),
      })
      .where(eq(itemTypeConfigs.itemType, itemType))
      .returning()

    if (result.length === 0) {
      throw new NotFoundError('ItemTypeConfig', itemType, {
        operation: 'deactivate',
      })
    }

    return result[0] as ItemTypeConfigRecord
  }

  /**
   * Reactivate a previously deactivated configuration
   */
  static async activateConfig(
    itemType: string,
    userId: string,
  ): Promise<ItemTypeConfigRecord> {
    const result = await db
      .update(itemTypeConfigs)
      .set({
        isActive: true,
        modifiedBy: userId,
        modifiedAt: new Date(),
      })
      .where(eq(itemTypeConfigs.itemType, itemType))
      .returning()

    if (result.length === 0) {
      throw new NotFoundError('ItemTypeConfig', itemType, {
        operation: 'activate',
      })
    }

    return result[0] as ItemTypeConfigRecord
  }

  /**
   * Get configuration history (all versions) for an item type
   * Note: Current implementation only stores latest version.
   * Full history would require a separate audit table (Phase 4).
   */
  static async getConfigVersion(itemType: string): Promise<number> {
    const config = await this.getConfig(itemType)
    return config?.version ?? 0
  }

  // ============================================
  // Lifecycle Validation Methods
  // ============================================

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
    const targetLifecycle = await WorkflowService.getById(targetLifecycleId)
    if (!targetLifecycle) {
      return {
        valid: false,
        errors: [`Lifecycle '${targetLifecycleId}' not found`],
        statesNotInTarget: [],
      }
    }

    if (targetLifecycle.definitionType !== 'lifecycle') {
      return {
        valid: false,
        errors: [`'${targetLifecycle.name}' is a workflow, not a lifecycle`],
        statesNotInTarget: [],
        targetLifecycleName: targetLifecycle.name,
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
      .where(and(eq(items.itemType, itemType), eq(items.isDeleted, false)))
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
      const currentLifecycle = await WorkflowService.getById(currentLifecycleId)
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

  /**
   * Validate and save config with lifecycle swap check
   */
  static async saveConfigWithLifecycleValidation(
    itemType: string,
    config: RuntimeItemTypeConfig,
    userId: string,
    currentLifecycleId?: string | null,
  ): Promise<ItemTypeConfigRecord> {
    // If lifecycleDefinitionId is changing, validate the swap
    if (config.lifecycleDefinitionId !== undefined) {
      const validation = await this.validateLifecycleSwap(
        itemType,
        currentLifecycleId,
        config.lifecycleDefinitionId,
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
    }

    return this.saveConfig(itemType, config, userId)
  }
}
