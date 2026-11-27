// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Composition root for the server processes: which modules this app attaches.
 *
 * The module package owns what gets registered; this file only decides that it
 * is registered at all. Core never imports a module — it declares extension
 * points, and this list is the one place that wires modules into them.
 *
 * **Server only.** Everything registered here reaches the database, so this
 * file must never enter the client bundle — importing it from a component
 * would drag `postgres` in behind it.
 */

import {
  registerCadGeneration,
  registerCadGenerationWorker,
  registerDesignEngine,
} from '@cascadia/design-engine/register.server'

/** Attach every module to core. Idempotent; each guards itself. */
export function registerModules(): void {
  registerCadGeneration()
  registerDesignEngine()
}

/** Attach module job handlers. **Worker entry points only.** */
export function registerWorkerModules(): void {
  registerCadGenerationWorker()
}
