// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { PgColumn, PgTable } from 'drizzle-orm/pg-core'
import type { TransactionClient } from '@/lib/db'

/**
 * An extension table: the type's own columns, keyed one-to-one on `itemId`.
 *
 * Typed structurally rather than per-table so generic machinery (see
 * `copyTypeSpecificData`) can work off the columns without a switch. Drizzle's
 * per-table types do not survive that generalisation, which is why the row
 * shape here is `any` — every use site reads columns by name.
 */
export type ExtensionTable = PgTable & { itemId: PgColumn }

/**
 * Interface for type-specific database operations.
 * Each item type implements this to handle its own table.
 */
export interface TypeHandler {
  /** The type's extension table, for column-driven operations. */
  table: ExtensionTable
  insert: (itemId: string, data: any, tx?: TransactionClient) => Promise<void>
  get: (itemId: string, tx?: TransactionClient) => Promise<any>
  update: (itemId: string, data: any, tx?: TransactionClient) => Promise<void>
  /**
   * Copy content this type keeps outside its extension row (child tables) from
   * one item version to another. Only types with such tables declare it.
   */
  copyChildren?: (
    sourceItemId: string,
    targetItemId: string,
    tx?: TransactionClient,
  ) => Promise<void>
}
