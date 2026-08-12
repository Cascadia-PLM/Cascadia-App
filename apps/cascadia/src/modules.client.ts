// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Composition root for the community edition's browser bundle — empty, for the
 * same reason as `modules.server.ts`.
 *
 * Every UI slot core renders simply has nothing registered against it and
 * renders nothing, which is the designed behaviour rather than a degraded one.
 */

export function registerClientModules(): void {
  // No modules in this edition.
}
