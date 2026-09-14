// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { resolveLifecycleType } from '../lifecycles/normalize'
import type { ItemTypeConfig } from './types/base'
import type { RuntimeItemTypeConfig } from './types/runtime-config'
import type { LifecycleDefinition } from '../lifecycles/types'
import type { ConfigService as ConfigServiceType } from '../config'
import type { LifecycleDefinitionService as LifecycleDefinitionServiceType } from '../lifecycles/LifecycleDefinitionService'

// Re-export for convenience
export type { RuntimeItemTypeConfig } from './types/runtime-config'

// Lazy import of ConfigService to break the static cycle: ConfigService
// imports this registry (it enforces the mandatory-lifecycle floor and
// reloads the caches after a write), and this registry reads its rows.
let ConfigServiceCache: typeof ConfigServiceType | null = null
async function getConfigService() {
  if (!ConfigServiceCache) {
    const module = await import('../config')
    ConfigServiceCache = module.ConfigService
  }
  return ConfigServiceCache
}

// Lazy import of LifecycleDefinitionService for lifecycle lookups
let LifecycleDefinitionServiceCache:
  typeof LifecycleDefinitionServiceType | null = null
async function getLifecycleDefinitionService() {
  if (!LifecycleDefinitionServiceCache) {
    const module = await import('../lifecycles/LifecycleDefinitionService')
    LifecycleDefinitionServiceCache = module.LifecycleDefinitionService
  }
  return LifecycleDefinitionServiceCache
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

  /**
   * The definition assigned to each item type, whatever its kind.
   *
   * Every `LifecycleService` question — "what state does release produce",
   * "what revision scheme", "is this action valid" — resolves through
   * `getAssignedDefinitionForType`, which was a fresh `SELECT` of the same
   * workflow-definition row each time. A change-order release asks ~30 of them,
   * most inside per-item loops, so a 50-item release did on the order of 250
   * redundant queries while holding a serializable transaction open.
   *
   * A definition cannot change mid-request, and every path that edits one
   * already invalidates here: `reload()` (admin item-type edits and the test
   * fixtures), `LifecycleDefinitionService.create/update/delete` (lifecycle edits), and
   * `unregister`/`clear`. `undefined` is cached too — "nothing assigned" is
   * asked about just as often. Driving definitions are cached like any other
   * and filtered out on read by `getLifecycleForType`; a lookup that throws
   * caches nothing, so the next caller asks the database again.
   */
  private static lifecycleCache = new Map<
    string,
    LifecycleDefinition | undefined
  >()

  /** Whether runtime configs have been loaded */
  private static isInitialized = false

  /** Initialization promise to prevent duplicate loads */
  private static initPromise: Promise<void> | null = null

  /**
   * How long a process may serve its cached runtime configuration before
   * reading the table again, and when it last did.
   *
   * These caches are per process, and the only invalidation is per process
   * too: `reload()` from the config write path, `invalidateLifecycleCache()`
   * from the lifecycle write path. The documented topology is N stateless app
   * replicas plus a separate jobs worker over one database, so an
   * administrator's lifecycle reassignment reached exactly the replica that
   * served the request and no other — with no time bound at all, since
   * nothing expired. Every other process kept the previous definition until
   * it restarted, and a stale definition is not a stale label: it decides
   * release-state resolution, revision schemes and, through
   * `isBranchProtectionExempt`, whether an item may be written to main.
   *
   * A bounded window is the cheap answer, and the one this codebase already
   * uses for role permissions (`PermissionService.CACHE_TTL`). Postgres
   * LISTEN/NOTIFY would propagate instantly but costs a dedicated connection
   * per process and a new failure mode to operate.
   *
   * The per-release memo this cache exists for is untouched: a refresh costs
   * one SELECT per interval per process, and a release finishes well inside
   * one. A refresh that does land mid-operation clears the memo, which is the
   * same thing an administrator's save has always done.
   */
  private static readonly REFRESH_INTERVAL_MS = 30_000
  private static loadedAt = 0

  /** In-flight refresh, so concurrent readers share one load. */
  private static refreshPromise: Promise<void> | null = null

  /**
   * Bumped by every path that empties a cache, so an async fill started
   * before the invalidation can tell that it did.
   *
   * `getAssignedDefinitionForType` reads the database and then writes what it
   * read into `lifecycleCache`. Between those two steps an admin's item-type
   * save (`reload`) or a lifecycle edit (`invalidateLifecycleCache`) can clear
   * the map, and the write then lands in the freshly cleared cache — putting
   * the pre-edit definition back, where nothing but another edit or a restart
   * will dislodge it. The synchronous clear-and-repopulate in
   * `loadRuntimeConfigs` has no such window; only the lazy fill does.
   */
  private static generation = 0

  /**
   * Register a new item type configuration from code.
   * This defines the base configuration including schema and components.
   */
  static register<T = any>(config: ItemTypeConfig<T>): void {
    this.codeDefinitions.set(config.name, config)
    // Invalidate merged cache for this type
    this.mergedCache.delete(config.name)
    this.lifecycleCache.delete(config.name)
    this.generation++
  }

  /**
   * Drop the memoized lifecycle definitions.
   *
   * Called from every path that can change one: this registry's own reload, and
   * `LifecycleDefinitionService.create/update/delete`. A lifecycle edit that does not land
   * here would be invisible until the process restarted.
   */
  static invalidateLifecycleCache(): void {
    this.lifecycleCache.clear()
    this.generation++
  }

  /**
   * Load runtime configurations from the database.
   *
   * Throws when the database cannot answer. It used to catch, log and return,
   * which made "the configs could not be read" indistinguishable from "there
   * are none" — and the difference matters, because `lifecycleDefinitionId`
   * is a runtime value: a registry that silently falls back to code defaults
   * resolves initial states, revision schemes and release targets from the
   * shipped lifecycle rather than the assigned one, and `reload()` reported
   * success to the admin who had just reassigned it. Callers decide what a
   * failure means; boot fails on it (see the composition roots), and the MCP
   * dev tool deliberately answers with code definitions alone.
   */
  static async loadRuntimeConfigs(): Promise<void> {
    const configService = await getConfigService()
    const configs = await configService.getAllConfigs()

    // Clear and repopulate below the await, so no caller can observe a
    // half-loaded registry: nothing yields between here and the last set().
    this.runtimeConfigs.clear()
    this.mergedCache.clear()
    this.lifecycleCache.clear()
    this.generation++

    for (const config of configs) {
      this.runtimeConfigs.set(config.itemType, config.config)
    }

    this.loadedAt = Date.now()
  }

  /**
   * Reload the runtime configuration if this process's copy has aged past
   * `REFRESH_INTERVAL_MS`; otherwise do nothing.
   *
   * Call it before reading anything an administrator can change — which,
   * since the runtime tier shrank to the lifecycle assignment, means the
   * lifecycle lookups below and the change-type mapping. A process that has
   * not initialized yet initializes here instead.
   */
  static async ensureFresh(): Promise<void> {
    if (!this.isInitialized) {
      return this.initialize()
    }

    if (Date.now() - this.loadedAt < ItemTypeRegistry.REFRESH_INTERVAL_MS) {
      return
    }

    this.refreshPromise ??= this.loadRuntimeConfigs().finally(() => {
      this.refreshPromise = null
    })

    return this.refreshPromise
  }

  /**
   * Initialize the registry by loading runtime configurations.
   *
   * Safe to call multiple times — concurrent callers share one load, and it
   * runs once per process. A failed load rejects and leaves the registry
   * uninitialized so the next caller retries, rather than marking itself
   * initialized and serving code defaults for the lifetime of the process.
   * Every composition root awaits this before serving anything.
   */
  static async initialize(): Promise<void> {
    if (this.isInitialized) {
      return
    }

    this.initPromise ??= this.loadRuntimeConfigs()
      .then(() => {
        this.isInitialized = true
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
      ...codeConfig,

      // The one field an administrator may override. Everything else comes
      // from code: see RuntimeItemTypeConfig for what used to be here and why
      // offering a setting nothing reads was worse than offering none.
      lifecycleDefinitionId:
        runtimeConfig.lifecycleDefinitionId ?? codeConfig.lifecycleDefinitionId,
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
    // Every key came from `codeDefinitions`, so `getType` answers for all of
    // them. (It used to assert non-null and then filter for null.)
    return Array.from(this.codeDefinitions.keys()).map(
      (name) => this.getType(name) as ItemTypeConfig,
    )
  }

  /**
   * Check if an item type is registered
   */
  static hasType(name: string): boolean {
    return this.codeDefinitions.has(name)
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
   * Unregister an item type (mainly for testing)
   */
  static unregister(name: string): boolean {
    this.codeDefinitions.delete(name)
    this.runtimeConfigs.delete(name)
    this.mergedCache.delete(name)
    this.lifecycleCache.delete(name)
    this.generation++
    return true
  }

  /**
   * Clear all registered types (mainly for testing)
   */
  static clear(): void {
    this.codeDefinitions.clear()
    this.runtimeConfigs.clear()
    this.mergedCache.clear()
    this.lifecycleCache.clear()
    this.generation++
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
   * The definition assigned to an item type, whatever its kind: the item
   * lifecycle of a Driven or Free type, or the change-order workflow of a
   * Driving one. `undefined` when the type has nothing assigned or the
   * assigned id matches no row.
   *
   * A failed lookup throws. It used to be caught, logged and answered as
   * `undefined`, which made "the database could not answer" the same answer
   * as "nothing assigned" — and `LifecycleService.getLifecycleType` turned
   * that into `'Free'`, the one kind branch protection exempts, so a transient
   * error while loading a Part's lifecycle let a direct write through to a
   * protected main. Nothing here decides what a missing answer means; every
   * consumer fails closed on the error instead.
   */
  static async getAssignedDefinitionForType(
    itemType: string,
  ): Promise<LifecycleDefinition | undefined> {
    // Before the memo, not after it: a type already memoized would otherwise
    // never notice that the interval had passed, and nothing would ever
    // refresh.
    await this.ensureFresh()

    if (this.lifecycleCache.has(itemType)) {
      return this.lifecycleCache.get(itemType)
    }

    const lifecycleId = this.getLifecycleDefinitionId(itemType)
    if (!lifecycleId) {
      this.lifecycleCache.set(itemType, undefined)
      return undefined
    }

    // Read the generation before the lookup and only memoize if no
    // invalidation landed while it was in flight; see `generation` above.
    const generation = this.generation
    const definitions = await getLifecycleDefinitionService()
    const definition = (await definitions.getById(lifecycleId)) ?? undefined
    if (generation === this.generation) {
      this.lifecycleCache.set(itemType, definition)
    }
    return definition
  }

  /**
   * Get the lifecycle definition for an item type: the assigned definition
   * when it is an item lifecycle (Driven or Free). Change-order workflows —
   * Driving definitions — never resolve as an item's lifecycle, so a type
   * governed by one answers `undefined` here; `getAssignedDefinitionForType`
   * returns the definition itself.
   */
  static async getLifecycleForType(
    itemType: string,
  ): Promise<LifecycleDefinition | undefined> {
    const definition = await this.getAssignedDefinitionForType(itemType)
    return definition && resolveLifecycleType(definition) !== 'Driving'
      ? definition
      : undefined
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
