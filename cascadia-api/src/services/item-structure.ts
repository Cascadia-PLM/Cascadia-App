// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, eq } from 'drizzle-orm'
import { referenceDesignatorKey } from '@cascadia/commons/types/bom'
import { optionConditionKey } from '@cascadia/commons/types/variants'
import { db } from '../db'
import { itemRelationships } from '../db/schema'

/**
 * An item's BOM structure, reduced to something two versions can be compared
 * on.
 *
 * The `items` row is not the item: a BOM edit changes no column on it. Both
 * the merge's pre-flight check and conflict detection need to know whether two
 * versions' structures diverged, and they used to answer differently — the
 * merge compared structure and refused, while detection compared only the item
 * row and reported nothing, so a BOM-only divergence on main was invisible in
 * the Conflicts tab and fatal at merge. One comparator, both callers.
 */
export interface BomStructure {
  /** Number of BOM lines, for display */
  lineCount: number
  /**
   * Order-independent identity of the line set: child, quantity, find number,
   * option, execution, reference designators. The designators count because
   * they tell two lines of one child apart; left out, a designator edited on
   * both sides compared equal and main's edit was released over.
   */
  signature: string
}

export async function bomStructureOf(
  itemId: string,
  tx?: Pick<typeof db, 'select'>,
): Promise<BomStructure> {
  const rows = await (tx ?? db)
    .select({
      targetId: itemRelationships.targetId,
      quantity: itemRelationships.quantity,
      findNumber: itemRelationships.findNumber,
      option: itemRelationships.option,
      targetMakeCode: itemRelationships.targetMakeCode,
      referenceDesignator: itemRelationships.referenceDesignator,
    })
    .from(itemRelationships)
    .where(
      and(
        eq(itemRelationships.sourceId, itemId),
        eq(itemRelationships.relationshipType, 'BOM'),
      ),
    )

  // JSON rather than a joined string: a designator is free text and may hold
  // any separator a join could pick.
  return {
    lineCount: rows.length,
    signature: rows
      .map((r) =>
        JSON.stringify([
          r.targetId,
          r.quantity ?? '',
          r.findNumber ?? '',
          optionConditionKey(r.option),
          r.targetMakeCode ?? '',
          referenceDesignatorKey('BOM', r.referenceDesignator),
        ]),
      )
      .sort()
      .join('|'),
  }
}

/** How a BOM structure reads in a conflict list. */
export function describeBomStructure(structure: BomStructure): string {
  return `${structure.lineCount} BOM line${structure.lineCount === 1 ? '' : 's'}`
}
