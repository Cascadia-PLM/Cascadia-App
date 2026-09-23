// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { JobHandler, JobTypeConfig, RuntimeJobTypeConfig } from './types'
import { jobLogger } from '@/lib/logging/logger'

/**
 * Central registry for all job types in Cascadia.
 *
 * Mirrors ItemTypeRegistry pattern:
 * - Code definitions: Type-safe configs defined in code
 * - Runtime configs: Business rules from database (future)
 * - Handlers: Execution logic for each job type
 */
class JobTypeRegistry {
  /** Code-defined job type configurations */
  private static codeDefinitions = new Map<string, JobTypeConfig>()

  /** Runtime configurations loaded from database (future) */
  private static runtimeConfigs = new Map<string, RuntimeJobTypeConfig>()

  /** Registered handlers for each job type */
  private static handlers = new Map<string, JobHandler<unknown, unknown>>()

  /** Merged configurations (cached for performance) */
  private static mergedCache = new Map<string, JobTypeConfig>()

  /** Whether runtime configs have been loaded */
  private static isInitialized = false

  /**
   * Register a job type configuration.
   * Called during app/worker startup.
   *
   * Re-registering the *same object* is a no-op: a definitions module can be
   * imported more than once (a re-run of `definitions/register.ts`, a dev-server
   * reload) without that meaning anything. A *different* config claiming a type
   * that is already taken is a conflict and throws — the previous behaviour
   * overwrote it silently, which loses timeout, retry and routing settings with
   * nothing in the type system or the logs to catch it.
   */
  static register<TPayload, TResult>(
    config: JobTypeConfig<TPayload, TResult>,
  ): void {
    const existing = this.codeDefinitions.get(config.type)
    if (existing) {
      if (existing === (config as JobTypeConfig)) return
      throw new Error(
        `Job type "${config.type}" is already registered with a different configuration`,
      )
    }
    jobLogger.debug({ type: config.type }, 'Registered job type')
    this.codeDefinitions.set(config.type, config)
    this.mergedCache.delete(config.type)
  }

  /**
   * Register a handler for a job type.
   * Called during worker startup.
   *
   * Same duplicate policy as {@link register}: identical reference is a no-op,
   * a second distinct handler for one type throws rather than winning silently.
   */
  static registerHandler<TPayload, TResult>(
    handler: JobHandler<TPayload, TResult>,
  ): void {
    const existing = this.handlers.get(handler.type)
    if (existing) {
      if (existing === (handler as unknown as JobHandler<unknown, unknown>))
        return
      throw new Error(
        `Job type "${handler.type}" already has a different handler registered`,
      )
    }
    if (!this.codeDefinitions.has(handler.type)) {
      jobLogger.warn(
        { type: handler.type },
        'Handler registered for unknown job type',
      )
    }
    this.handlers.set(handler.type, handler as JobHandler<unknown, unknown>)
    jobLogger.debug({ type: handler.type }, 'Registered handler')
  }

  /**
   * Merge code definition with runtime configuration.
   */
  private static mergeConfigs(
    codeConfig: JobTypeConfig,
    runtimeConfig?: RuntimeJobTypeConfig,
  ): JobTypeConfig {
    if (!runtimeConfig) {
      return codeConfig
    }

    return {
      ...codeConfig,
      priority: runtimeConfig.priority ?? codeConfig.priority,
      maxConcurrent: runtimeConfig.maxConcurrent ?? codeConfig.maxConcurrent,
      rateLimitPerMinute:
        runtimeConfig.rateLimitPerMinute ?? codeConfig.rateLimitPerMinute,
    }
  }

  /**
   * Get configuration for a job type.
   * Returns merged config (runtime overrides code defaults).
   */
  static getType(type: string): JobTypeConfig | undefined {
    if (this.mergedCache.has(type)) {
      return this.mergedCache.get(type)
    }

    const codeConfig = this.codeDefinitions.get(type)
    if (!codeConfig) {
      return undefined
    }

    const runtimeConfig = this.runtimeConfigs.get(type)
    const merged = this.mergeConfigs(codeConfig, runtimeConfig)
    this.mergedCache.set(type, merged)
    return merged
  }

  /**
   * Get handler for a job type.
   */
  static getHandler<TPayload = unknown, TResult = unknown>(
    type: string,
  ): JobHandler<TPayload, TResult> | undefined {
    return this.handlers.get(type) as JobHandler<TPayload, TResult> | undefined
  }

  /**
   * Get all registered job types.
   */
  static getAllTypes(): Array<JobTypeConfig> {
    return Array.from(this.codeDefinitions.keys())
      .map((type) => this.getType(type)!)
      .filter(Boolean)
  }

  /**
   * Get job types matching a routing pattern.
   * Used by workers to find handlers for their subscribed patterns.
   *
   * @param pattern RabbitMQ routing pattern (e.g., 'jobs.notification.*', 'jobs.#')
   */
  static getTypesForPattern(pattern: string): Array<JobTypeConfig> {
    const regex = this.routingPatternToRegex(pattern)
    return this.getAllTypes().filter((config) => regex.test(config.routingKey))
  }

  /**
   * Check if a job type is registered.
   */
  static hasType(type: string): boolean {
    return this.codeDefinitions.has(type)
  }

  /**
   * Check if a handler is registered for a job type.
   */
  static hasHandler(type: string): boolean {
    return this.handlers.has(type)
  }

  /**
   * Get routing keys for all job types that have registered handlers.
   * Used by workers to bind only to patterns they can actually process,
   * avoiding DLQ pollution from messages intended for other workers.
   */
  static getHandledRoutingKeys(): Array<string> {
    return Array.from(this.handlers.keys())
      .map((type) => this.codeDefinitions.get(type)?.routingKey)
      .filter((key): key is string => key != null)
  }

  /**
   * Check if registry is initialized.
   */
  static isReady(): boolean {
    return this.isInitialized
  }

  /**
   * Mark registry as initialized.
   */
  static markInitialized(): void {
    this.isInitialized = true
    jobLogger.debug('Registry initialization complete')
  }

  /**
   * Convert RabbitMQ routing pattern to regex.
   * '*' matches exactly one word, '#' matches zero or more words.
   */
  private static routingPatternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '[^.]+')
      .replace(/#/g, '.*')
    return new RegExp(`^${escaped}$`)
  }

  /**
   * Clear registry (for testing).
   */
  static clear(): void {
    this.codeDefinitions.clear()
    this.runtimeConfigs.clear()
    this.handlers.clear()
    this.mergedCache.clear()
    this.isInitialized = false
  }

  /**
   * Get statistics about registered types and handlers.
   */
  static getStats(): { types: number; handlers: number; ready: boolean } {
    return {
      types: this.codeDefinitions.size,
      handlers: this.handlers.size,
      ready: this.isInitialized,
    }
  }
}

export { JobTypeRegistry }
