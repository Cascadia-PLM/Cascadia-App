import type { ItemTypeConfig, StateConfig } from './types/base'
import type { RuntimeItemTypeConfig } from './types/runtime-config'
import type { WorkflowDefinition } from '../workflows/types'
import type { ConfigService as ConfigServiceType } from '../config'
import type { WorkflowService as WorkflowServiceType } from '../workflows/WorkflowService'

// Re-export for convenience
export type { RuntimeItemTypeConfig } from './types/runtime-config'

// Lazy import of ConfigService to avoid bundling database code in client
// This is only used on the server in loadRuntimeConfigs()
let ConfigServiceCache: typeof ConfigServiceType | null = null
async function getConfigService() {
  if (!ConfigServiceCache) {
    const module = await import('../config')
    ConfigServiceCache = module.ConfigService
  }
  return ConfigServiceCache
}

// Lazy import of WorkflowService for lifecycle lookups
let WorkflowServiceCache: typeof WorkflowServiceType | null = null
async function getWorkflowService() {
  if (!WorkflowServiceCache) {
    const module = await import('../workflows/WorkflowService')
    WorkflowServiceCache = module.WorkflowService
  }
  return WorkflowServiceCache
}

/**
 * Central registry for all item types in the PLM system.
 *
 * Implements a two-tier configuration pattern:
 * - Code definitions: Type-safe configs defined in code (schema, components, table)
 * - Runtime configs: Business rules from database (permissions, labels, states)
 *
 * Runtime configs override code defaults for configurable fields.
 * Components and schemas always come from code for type safety.
 */
class ItemTypeRegistry {
  /** Code-defined item type configurations */
  private static codeDefinitions = new Map<string, ItemTypeConfig>()

  /** Runtime configurations loaded from database */
  private static runtimeConfigs = new Map<string, RuntimeItemTypeConfig>()

  /** Merged configurations (cached for performance) */
  private static mergedCache = new Map<string, ItemTypeConfig>()

  /** Whether runtime configs have been loaded */
  private static isInitialized = false

  /** Initialization promise to prevent duplicate loads */
  private static initPromise: Promise<void> | null = null

  /**
   * Register a new item type configuration from code.
   * This defines the base configuration including schema and components.
   */
  static register<T = any>(config: ItemTypeConfig<T>): void {
    this.codeDefinitions.set(config.name, config)
    // Invalidate merged cache for this type
    this.mergedCache.delete(config.name)
  }

  /**
   * Load runtime configurations from the database.
   * Called during server initialization.
   */
  static async loadRuntimeConfigs(): Promise<void> {
    try {
      const configService = await getConfigService()
      const configs = await configService.getAllConfigs()

      this.runtimeConfigs.clear()
      this.mergedCache.clear()

      for (const config of configs) {
        this.runtimeConfigs.set(config.itemType, config.config)
      }
    } catch (error) {
      // Log but don't fail - code defaults will be used
      console.error('[ItemTypeRegistry] Failed to load runtime configs:', error)
    }
  }

  /**
   * Initialize the registry by loading runtime configurations.
   * Safe to call multiple times - will only load once.
   */
  static async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    // Prevent duplicate initialization
    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this.loadRuntimeConfigs()
      .then(() => {
        this.isInitialized = true
      })
      .catch((error) => {
        // Mark as initialized even on failure to prevent retry loops
        this.isInitialized = true
        console.error(
          '[ItemTypeRegistry] Initialization failed, using code defaults:',
          error,
        )
      })
      .finally(() => {
        this.initPromise = null
      })

    return this.initPromise
  }

  /**
   * Merge code definition with runtime configuration.
   * Runtime values override code defaults for configurable fields.
   * Components and schema always come from code.
   */
  private static mergeConfigs(
    codeConfig: ItemTypeConfig,
    runtimeConfig?: RuntimeItemTypeConfig,
  ): ItemTypeConfig {
    if (!runtimeConfig) {
      return codeConfig
    }

    return {
      // Always from code (type safety)
      name: codeConfig.name,
      schema: codeConfig.schema,
      table: codeConfig.table,
      components: codeConfig.components,
      defaultState: codeConfig.defaultState,
      searchableFields: codeConfig.searchableFields,
      displayField: codeConfig.displayField,
      states: codeConfig.states, // Deprecated: states now come from lifecycle definition

      // Runtime overrides code defaults
      label: runtimeConfig.label ?? codeConfig.label,
      pluralLabel: runtimeConfig.pluralLabel ?? codeConfig.pluralLabel,
      icon: runtimeConfig.icon ?? codeConfig.icon,
      lifecycleDefinitionId:
        runtimeConfig.lifecycleDefinitionId ?? codeConfig.lifecycleDefinitionId,
      permissions: runtimeConfig.permissions ?? codeConfig.permissions,
      relationships: runtimeConfig.relationships ?? codeConfig.relationships,
    }
  }

  /**
   * Get configuration for a specific item type.
   * Returns merged config (runtime overrides code defaults).
   */
  static getType(name: string): ItemTypeConfig | undefined {
    // Check cache first
    if (this.mergedCache.has(name)) {
      return this.mergedCache.get(name)
    }

    const codeConfig = this.codeDefinitions.get(name)
    if (!codeConfig) {
      return undefined
    }

    const runtimeConfig = this.runtimeConfigs.get(name)
    const merged = this.mergeConfigs(codeConfig, runtimeConfig)

    // Cache the merged result
    this.mergedCache.set(name, merged)
    return merged
  }

  /**
   * Get all registered item types (merged configurations)
   */
  static getAllTypes(): Array<ItemTypeConfig> {
    return Array.from(this.codeDefinitions.keys())
      .map((name) => this.getType(name)!)
      .filter(Boolean)
  }

  /**
   * Check if an item type is registered
   */
  static hasType(name: string): boolean {
    return this.codeDefinitions.has(name)
  }

  /**
   * Get item types that can be created by a user with specific roles
   */
  static getTypesForRoles(roles: Array<string>): Array<ItemTypeConfig> {
    return this.getAllTypes().filter((type) => {
      return type.permissions.create.some(
        (permission) => permission === '*' || roles.includes(permission),
      )
    })
  }

  /**
   * Reload runtime configurations from database.
   * Call this after updating configurations via admin UI.
   */
  static async reload(): Promise<void> {
    this.isInitialized = false
    await this.loadRuntimeConfigs()
    this.isInitialized = true
  }

  /**
   * Get only the runtime configuration for an item type (if any)
   */
  static getRuntimeConfig(name: string): RuntimeItemTypeConfig | undefined {
    return this.runtimeConfigs.get(name)
  }

  /**
   * Get only the code definition for an item type
   */
  static getCodeDefinition(name: string): ItemTypeConfig | undefined {
    return this.codeDefinitions.get(name)
  }

  /**
   * Check if runtime configs have been loaded
   */
  static isReady(): boolean {
    return this.isInitialized
  }

  /**
   * Unregister an item type (mainly for testing)
   */
  static unregister(name: string): boolean {
    this.codeDefinitions.delete(name)
    this.runtimeConfigs.delete(name)
    this.mergedCache.delete(name)
    return true
  }

  /**
   * Clear all registered types (mainly for testing)
   */
  static clear(): void {
    this.codeDefinitions.clear()
    this.runtimeConfigs.clear()
    this.mergedCache.clear()
    this.isInitialized = false
    this.initPromise = null
  }

  // ============================================
  // Lifecycle Resolution Methods
  // ============================================

  /**
   * Get the lifecycle definition ID for an item type.
   * Returns undefined if no lifecycle is assigned.
   */
  static getLifecycleDefinitionId(itemType: string): string | undefined {
    const config = this.getType(itemType)
    return config?.lifecycleDefinitionId
  }

  /**
   * Get the lifecycle definition for an item type.
   * Fetches from database using WorkflowService.
   * Returns undefined if no lifecycle is assigned or not found.
   */
  static async getLifecycleForType(
    itemType: string,
  ): Promise<WorkflowDefinition | undefined> {
    const lifecycleId = this.getLifecycleDefinitionId(itemType)
    if (!lifecycleId) {
      return undefined
    }

    try {
      const workflowService = await getWorkflowService()
      const lifecycle = await workflowService.getById(lifecycleId)

      // Ensure it's actually a lifecycle, not a workflow
      if (lifecycle && lifecycle.definitionType === 'lifecycle') {
        return lifecycle
      }
      return undefined
    } catch (error) {
      console.error(
        `[ItemTypeRegistry] Failed to fetch lifecycle for ${itemType}:`,
        error,
      )
      return undefined
    }
  }

  /**
   * Get the valid states for an item type from its lifecycle definition.
   * Falls back to deprecated code-defined states if no lifecycle is assigned.
   */
  static async getStatesForType(itemType: string): Promise<Array<StateConfig>> {
    const lifecycle = await this.getLifecycleForType(itemType)

    if (lifecycle) {
      // Map lifecycle states to StateConfig format
      return lifecycle.states.map((state) => ({
        id: state.id,
        name: state.name,
        color: state.color,
        description: state.description,
      }))
    }

    // Fallback to deprecated code-defined states
    const config = this.getType(itemType)
    return config?.states || []
  }

  /**
   * Get all item types that use a specific lifecycle definition.
   * Used for validation when modifying or deleting a lifecycle.
   */
  static getItemTypesUsingLifecycle(
    lifecycleDefinitionId: string,
  ): Array<string> {
    const itemTypes: Array<string> = []

    for (const [name, _] of this.codeDefinitions) {
      const config = this.getType(name)
      if (config?.lifecycleDefinitionId === lifecycleDefinitionId) {
        itemTypes.push(name)
      }
    }

    return itemTypes
  }
}

export { ItemTypeRegistry }
