// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { DomainEventDefinition } from './types'

/**
 * Catalog of every domain event type this process can emit or reason about.
 *
 * Mirrors `JobTypeRegistry`: core definitions register at import time via
 * `defineDomainEvent()`, module-owned ones from the composition root. The
 * registry powers introspection (the events API, docs) and lets consumers
 * look up payload schemas; publishing itself carries the definition, so an
 * emitted event is always in the catalog of the process that emitted it.
 */
export class EventTypeRegistry {
  private static definitions = new Map<string, DomainEventDefinition>()

  static register<TPayload extends Record<string, unknown>>(
    definition: DomainEventDefinition<TPayload>,
  ): void {
    const existing = this.definitions.get(definition.type)
    // The same object again is what a re-imported definitions module
    // produces — a no-op. A different object under the same type is a
    // conflict: two payload contracts claiming one wire name, and whichever
    // registered last would silently decide what consumers see. Same policy
    // as every other registry a module contributes to.
    if (existing === definition) return
    if (existing) {
      throw new Error(
        `Domain event type "${definition.type}" is already registered`,
      )
    }
    this.definitions.set(definition.type, definition)
  }

  static getType(type: string): DomainEventDefinition | undefined {
    return this.definitions.get(type)
  }

  static hasType(type: string): boolean {
    return this.definitions.has(type)
  }

  /** Every registered definition, sorted by type name for stable output. */
  static list(): Array<DomainEventDefinition> {
    return [...this.definitions.values()].sort((a, b) =>
      a.type.localeCompare(b.type),
    )
  }

  /** Drop every definition. Tests only. */
  static clear(): void {
    this.definitions.clear()
  }
}
