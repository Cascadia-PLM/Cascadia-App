// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Composition root for the browser bundle.
 *
 * Split from `modules.server.ts` because everything that one registers reaches
 * the database. Nothing imported here may touch a service, a schema, or
 * `@/db`.
 */

import {
  registerCadGenerationClient,
  registerDesignEngineClient,
} from '@cascadia/design-engine/register.client'

/** Attach every module's UI to core. Idempotent; each guards itself. */
export function registerClientModules(): void {
  registerCadGenerationClient()
  registerDesignEngineClient()
}
