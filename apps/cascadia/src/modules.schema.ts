// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The database schema this edition owns — core's tables and nothing else.
 *
 * Read statically by drizzle-kit and by `truncate-all`, so it has to be a plain
 * re-export rather than a registry. The enterprise sibling adds each module's
 * schema file beneath this same line.
 */

export * from '@cascadia/core/lib/db/schema'
