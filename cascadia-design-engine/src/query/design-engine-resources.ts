// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Query resources belonging to this package, registered into core's
 * invalidation graph with `registerResourceDependents()` — core cannot name a
 * module's resources, so the module adds its own edges.
 */

import { registerResourceDependents } from '@/query/invalidation'

declare module '@/query/keys' {
  interface ModuleResources {
    /** design-engine — collaborative design sessions. */
    'design-engine': true
  }
}

/** Wire this package's resources into the invalidation graph. Idempotent. */
export function registerDesignEngineResources(): void {
  registerResourceDependents({
    // Materializing a design session writes real PLM items.
    'design-engine': ['items', 'parts', 'designs', 'requirements'],
  })
}
