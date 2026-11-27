// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The database schema this app owns — core's tables plus every module's.
 *
 * The third composition root, alongside `modules.server.ts` and
 * `modules.client.ts`, and the only one that is a plain re-export rather than a
 * registry. **drizzle-kit reads this file statically**: it parses the module
 * for exported `pgTable` objects and never executes a registration call, so a
 * runtime registry would be invisible to it and `db:push` would propose
 * dropping every module table it could not see.
 *
 * Consumed by:
 *   - `drizzle.config.ts` — so `db:push`/`db:generate` manage module tables too
 *   - `scripts/truncate-all.ts` — so `db:reset` clears them
 *
 * Deliberately *not* consumed by `cascadia-api/src/db/index.ts`, which builds
 * its drizzle client from core's schema alone at module load, before any
 * composition root has run. Nothing needs the difference: no module uses the
 * relational `db.query.*` API on its own tables, and
 * `db.select().from(theirTable)` works regardless because a table object
 * carries its own metadata.
 */

// Core
export * from '@cascadia/api/db/schema'

// design-engine
export * from '@cascadia/design-engine/db/schema/design-engine'
