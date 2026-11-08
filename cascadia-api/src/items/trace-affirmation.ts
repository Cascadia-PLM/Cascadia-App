// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { catalogValues } from '@cascadia/commons/items/relationships/catalog'
import { AFFIRMATION_KEY } from '@cascadia/commons/items/relationships/metadata'

import type { SuspectReason } from '@cascadia/commons/items/suspect-reason'

/**
 * Suspect links: which traceability claims are still known to be true.
 *
 * A trace edge is a claim one item version makes about another — "this part
 * satisfies that requirement", "this test verifies it". Both ends revise, and
 * the claim is only as good as the versions it was made against. An edge
 * therefore carries an **affirmation** in its `metadata`: the source row it
 * hung off and the target row it was checked against when someone last said
 * the claim holds. The edge is **suspect** whenever either end has moved on
 * from that pair, until someone affirms it again.
 *
 * Nothing here is new storage. The affirmation rides the edge's own `metadata`
 * column, and the two places that move an edge between versions already carry
 * that column or re-home it:
 *
 * - **Checkout** copies an item's outgoing edges onto its working copy
 *   (`copyRelationshipsToItem`). The copy's `sourceId` is the new row and its
 *   affirmation still names the released one, so a carried claim reads as
 *   suspect on the branch from the moment the item is checked out — which is
 *   exactly when the person changing the item should say whether it still
 *   holds. A claim that predates affirmations gets the reading written onto
 *   the copy (the released row, by its author, when it was made), so it is
 *   suspect there like any other. Affirming on the branch records the working
 *   copy as the source.
 * - **Merge** re-homes the working copy's edges onto the released row and
 *   re-points every affirmation that named the working copy, so a claim
 *   affirmed inside the change order is released affirmed, and one that was
 *   never looked at is released suspect.
 * - **The other end revising** needs no write at all: the affirmation names a
 *   target row, and once a release supersedes that row the claim is suspect by
 *   comparison, wherever the edge lives.
 *
 * Affirming is a review record, not a design change. It never alters what the
 * link says, so it is written without the edit lock the link itself answers
 * to — a released part's satisfaction claims can be re-affirmed after the
 * requirement revises without opening a change order on the part.
 *
 * Suspicion is judged against **released** rows only: a target pinned to a
 * working copy is a branch's own edit and counts as current, the same rule
 * `followSupersededRows` applies to every other read.
 */

/**
 * The edge types whose claims can go stale: the catalog's `suspectable`
 * entries. `Evidences` is as-built and never does; `DERIVES_FROM` is a
 * hierarchy, not a claim.
 */
export const SUSPECTABLE_RELATIONSHIP_TYPES: ReadonlySet<string> =
  catalogValues((entry) => entry.suspectable)

export function isSuspectable(relationshipType: string): boolean {
  return SUSPECTABLE_RELATIONSHIP_TYPES.has(relationshipType)
}

/**
 * The key under which an edge's `metadata` holds its affirmation. Declared in
 * commons with the other reserved metadata keys, which no caller may write.
 */
export { AFFIRMATION_KEY }

export interface TraceAffirmation {
  /** The version row the edge hung off when the claim was affirmed. */
  sourceId: string
  /** The target version row the claim was affirmed against. */
  targetId: string
  affirmedBy: string
  /** ISO timestamp. */
  affirmedAt: string
}

export type { SuspectReason }

export interface SuspectState {
  suspect: boolean
  reasons: Array<SuspectReason>
  /** What the edge records, or null for an edge that predates affirmations. */
  affirmation: TraceAffirmation | null
}

interface EdgeLike {
  sourceId: string
  targetId: string
  relationshipType: string
  metadata: unknown
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The affirmation an edge's `metadata` carries, or null when it carries none. */
export function affirmationOf(metadata: unknown): TraceAffirmation | null {
  const record = asRecord(metadata)
  const raw = record ? asRecord(record[AFFIRMATION_KEY]) : null
  if (!raw) return null
  const { sourceId, targetId, affirmedBy, affirmedAt } = raw
  if (
    typeof sourceId !== 'string' ||
    typeof targetId !== 'string' ||
    typeof affirmedBy !== 'string' ||
    typeof affirmedAt !== 'string'
  ) {
    return null
  }
  return { sourceId, targetId, affirmedBy, affirmedAt }
}

/** `metadata` with the affirmation set, every other key left as it was. */
export function withAffirmation(
  metadata: unknown,
  affirmation: TraceAffirmation,
): Record<string, unknown> {
  return { ...(asRecord(metadata) ?? {}), [AFFIRMATION_KEY]: affirmation }
}

/**
 * The `metadata` a brand-new edge is born with: its author affirms the claim
 * against the rows the edge names. An edge type that cannot go stale keeps
 * whatever `metadata` the caller supplied, untouched.
 */
export function stampInitialAffirmation(
  metadata: unknown,
  edge: { sourceId: string; targetId: string; relationshipType: string },
  userId: string,
  now: Date = new Date(),
): unknown {
  if (!isSuspectable(edge.relationshipType)) return metadata
  return withAffirmation(metadata, {
    sourceId: edge.sourceId,
    targetId: edge.targetId,
    affirmedBy: userId,
    affirmedAt: now.toISOString(),
  })
}

/**
 * Re-home an edge's affirmation when a merge moves the edge from a working
 * copy onto the row the release minted.
 *
 * Only an affirmation that names the working copy follows it: that is a claim
 * made on the branch, and the released row is the same content promoted. One
 * still naming the row the release superseded was never re-affirmed on the
 * branch, and stays stale — which is the point. The target side follows the
 * same mapping the edge's own `targetId` does, so a claim affirmed against a
 * requirement revised in the same change order lands affirmed against the
 * requirement's released row.
 */
export function carryAffirmation(
  metadata: unknown,
  move: {
    fromSourceId: string
    toSourceId: string
    resolveTarget: (targetId: string) => string
  },
): unknown {
  const affirmation = affirmationOf(metadata)
  if (!affirmation) return metadata
  const next: TraceAffirmation = {
    ...affirmation,
    sourceId:
      affirmation.sourceId === move.fromSourceId
        ? move.toSourceId
        : affirmation.sourceId,
    targetId: move.resolveTarget(affirmation.targetId),
  }
  if (
    next.sourceId === affirmation.sourceId &&
    next.targetId === affirmation.targetId
  ) {
    return metadata
  }
  return withAffirmation(metadata, next)
}

/**
 * Whether a claim still stands, given the row that currently answers for its
 * target (`currentTargetId`: the pinned target itself, or the released row
 * that superseded it).
 *
 * An edge without an affirmation predates them and is read as affirmed by its
 * author against the rows it names, so existing data is suspect only when a
 * target it pins has since been superseded — never retroactively on the source
 * side, where the stored row *is* the row it hangs off.
 */
export function suspectStateOf(
  edge: EdgeLike,
  currentTargetId: string,
): SuspectState {
  const affirmation = affirmationOf(edge.metadata)
  if (!isSuspectable(edge.relationshipType)) {
    return { suspect: false, reasons: [], affirmation }
  }

  const affirmed = affirmation ?? {
    sourceId: edge.sourceId,
    targetId: edge.targetId,
  }
  const reasons: Array<SuspectReason> = []
  if (affirmed.sourceId !== edge.sourceId) reasons.push('source_revised')
  if (affirmed.targetId !== currentTargetId) reasons.push('target_revised')

  return { suspect: reasons.length > 0, reasons, affirmation }
}
