// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Composition root for the community edition — deliberately empty.
 *
 * The enterprise app's sibling attaches licensed modules here. This one has
 * none to attach, and that is the entire difference between the two editions
 * on the server: not a stripped tree, not a conditional, just a shorter list.
 *
 * Keeping the file rather than deleting it is what lets the shared entry points
 * be identical between editions.
 */

export function registerModules(): void {
  // No modules in this edition.
}

/** Worker-only counterpart. Nothing to register here either. */
export function registerWorkerModules(): void {
  // No modules in this edition.
}
