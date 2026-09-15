// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '../db'
import { branchItems, itemRelationships, items } from '../db/schema'
import type { TransactionClient } from '../db'

/**
 * Clear the top-level designation of every Part that a BOM line in its own
 * design nests — the state the application keeps from now on, applied to
 * rows written without it.
 *
 * `items.in_design_structure` says a Part is a designated top-level part of
 * its design's structure. The services clear it as a part is nested
 * (ItemRelationshipService.clearDesignationOfNestedTargets, and the merge for
 * lines a release promotes to main), but rows that arrive by other roads —
 * a demo bundle baked from a database that predates the rule, a seed that
 * inserts its BOM directly — carry whatever their source had, which for a
 * pre-rule source is `true` on every part. This is that rule as one
 * statement, and the migration that introduced it (folded into
 * `0004_change_management_and_design_structure`) runs the same SQL by hand;
 * keep the two in step.
 *
 * A part counts as nested when a BOM line from a source row in the same
 * design names any version of its master, and the source row is one a
 * structure view resolves to: a current, released-or-pre-release row (main's
 * view), or a working copy on the same branch as the part's own working copy
 * (that branch's view). A line owned only by a superseded revision, or only
 * by a branch's working copy pointing at a main row, nests nothing here —
 * the first is history, and the second is the merge's job when it releases.
 *
 * Idempotent: it writes only rows still designated, and returns how many.
 */
export async function clearDesignationOfNestedParts(
  options: { designIds?: Array<string>; tx?: TransactionClient } = {},
): Promise<number> {
  const executor = options.tx ?? db
  const source = alias(items, 'nesting_source')
  const targetVersion = alias(items, 'nested_version')
  const sourceTracking = alias(branchItems, 'source_tracking')
  const targetTracking = alias(branchItems, 'target_tracking')

  const sameBranchWorkingCopies = executor
    .select({ one: sql`1` })
    .from(sourceTracking)
    .innerJoin(
      targetTracking,
      eq(targetTracking.branchId, sourceTracking.branchId),
    )
    .where(
      and(
        eq(sourceTracking.currentItemId, source.id),
        eq(targetTracking.currentItemId, items.id),
        isNotNull(sourceTracking.changeType),
        isNotNull(targetTracking.changeType),
      ),
    )

  const nestingLine = executor
    .select({ one: sql`1` })
    .from(itemRelationships)
    .innerJoin(source, eq(source.id, itemRelationships.sourceId))
    .innerJoin(targetVersion, eq(targetVersion.id, itemRelationships.targetId))
    .where(
      and(
        eq(itemRelationships.relationshipType, 'BOM'),
        eq(targetVersion.masterId, items.masterId),
        eq(source.designId, items.designId),
        or(eq(source.isDeleted, false), sql`${source.isDeleted} IS NULL`),
        or(
          and(
            eq(source.isCurrent, true),
            not(sql`${source.revision} LIKE '-%'`),
            ne(source.revision, 'DRAFT'),
            ne(source.revision, ''),
          ),
          exists(sameBranchWorkingCopies),
        ),
      ),
    )

  const cleared = await executor
    .update(items)
    .set({ inDesignStructure: false })
    .where(
      and(
        eq(items.itemType, 'Part'),
        eq(items.inDesignStructure, true),
        options.designIds
          ? inArray(items.designId, options.designIds)
          : undefined,
        exists(nestingLine),
      ),
    )
    .returning({ id: items.id })

  return cleared.length
}
