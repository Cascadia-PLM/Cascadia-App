// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { eq } from 'drizzle-orm'
import { getTypeHandler } from './index'
import './init'
import type { TransactionClient } from '@/lib/db'
import { db } from '@/lib/db'

/**
 * Columns never carried from one item version to the next.
 *
 * `draftManifestId` is the uncommitted editor state of a software item's source
 * tree. A new version — whether a working copy opened for revision or a released
 * version written at merge — starts from the committed manifest, never from
 * someone's in-progress edits.
 */
const NEVER_COPIED = new Set(['draftManifestId'])

/**
 * Copy an item's type-specific data from one item version to another.
 *
 * Every item type stores its own fields in an extension table keyed by
 * `itemId`, so this copies **the whole row** rather than a hand-maintained
 * field list. That is the point: the two hand-written copies this replaced had
 * already drifted from the schema in opposite directions — one dropped a Part's
 * `trackingMode`, the other dropped the (since-removed) inventory columns —
 * and every column added since would have had to be remembered in both.
 * Copying by row means a new column is carried forward the day it exists.
 *
 * Types whose content spills into child tables (WorkInstruction: operations,
 * steps, attachments) declare a `copyChildren` on their handler; it runs even
 * when there is no extension row, since the children are keyed independently.
 */
export async function copyTypeSpecificData(
  itemType: string,
  sourceItemId: string,
  targetItemId: string,
  tx?: TransactionClient,
): Promise<void> {
  const handler = getTypeHandler(itemType)
  if (!handler) return

  const run = tx ?? db
  const table = handler.table

  const source = await run
    .select()
    .from(table)
    .where(eq(table.itemId, sourceItemId))
    .limit(1)
    .then((rows: Array<Record<string, unknown>>) => rows.at(0))

  if (source) {
    const values: Record<string, unknown> = { itemId: targetItemId }
    for (const [column, value] of Object.entries(source)) {
      if (column === 'itemId' || NEVER_COPIED.has(column)) continue
      values[column] = value
    }

    await run.insert(table).values(values).onConflictDoNothing()
  }

  await handler.copyChildren?.(sourceItemId, targetItemId, tx)
}
