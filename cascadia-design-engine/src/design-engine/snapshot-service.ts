// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Session Snapshot Service
 *
 * Append-only snapshots of a session's artifacts, captured at every
 * review-gate confirmation. They are the diff bases for review stages and
 * the restore targets for reopen_stage.
 */

import { and, asc, desc, eq } from 'drizzle-orm'
import type { DesignArtifacts } from './types'
import { db } from '@/db'
import { designSessionSnapshots } from '@/db/schema/design-engine'
import { asPostgresError, constraintOf, isUniqueViolation } from '@/errors/pg'
import { ConflictError } from '@/errors'

export interface DesignSessionSnapshot {
  id: string
  sessionId: string
  stage: string
  seq: number
  artifacts: DesignArtifacts
  llmHistoryLength: number
  createdAt: Date
}

export type DesignSessionSnapshotMeta = Omit<DesignSessionSnapshot, 'artifacts'>

/**
 * How many times `create` will re-read max(seq) after losing the number to a
 * concurrent writer.
 *
 * A caller can only lose to a *commit* that landed inside its own window, and
 * each competing writer commits once, so the bound needed is the number of
 * writers a session can have at one time — which the stream claim caps at one.
 * Five is therefore generous by a wide margin, and still bounded: exhausting
 * it means something is minting snapshots outside the claim, which is worth a
 * 409 rather than an unbounded loop.
 */
const SEQ_ATTEMPTS = 5

export class DesignSnapshotService {
  /**
   * Append a snapshot, minting the next seq for the session.
   *
   * The seq is read and then written in a READ COMMITTED transaction, which
   * does not stop a second transaction reading the same maximum: both used to
   * insert the same number, and `getLatestForStage` — the diff base for a
   * review stage and the target of a rollback — then picked between the tied
   * rows by row order. `uq_design_snapshots_session_seq` makes the loser fail;
   * this retries it, so it re-reads and lands on the next free value.
   */
  static async create(
    sessionId: string,
    stage: string,
    artifacts: DesignArtifacts,
    llmHistoryLength: number,
  ): Promise<DesignSessionSnapshot> {
    for (let attempt = 0; attempt < SEQ_ATTEMPTS; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const [latest] = await tx
            .select({ seq: designSessionSnapshots.seq })
            .from(designSessionSnapshots)
            .where(eq(designSessionSnapshots.sessionId, sessionId))
            .orderBy(desc(designSessionSnapshots.seq))
            .limit(1)

          const [snapshot] = await tx
            .insert(designSessionSnapshots)
            .values({
              sessionId,
              stage,
              seq: (latest?.seq ?? 0) + 1,
              artifacts,
              llmHistoryLength,
            })
            .returning()

          return snapshot as DesignSessionSnapshot
        })
      } catch (error) {
        const pgError = asPostgresError(error)
        const lostTheSeq =
          isUniqueViolation(error) &&
          pgError !== null &&
          constraintOf(pgError) === 'uq_design_snapshots_session_seq'
        if (!lostTheSeq) throw error
      }
    }

    throw new ConflictError(
      'Could not allocate a snapshot sequence number for this design session; retry',
      { operation: 'DesignSnapshotService.create', sessionId },
    )
  }

  /** Snapshot metadata (no artifacts payload), newest first. */
  static async listBySession(
    sessionId: string,
  ): Promise<Array<DesignSessionSnapshotMeta>> {
    const rows = await db
      .select({
        id: designSessionSnapshots.id,
        sessionId: designSessionSnapshots.sessionId,
        stage: designSessionSnapshots.stage,
        seq: designSessionSnapshots.seq,
        llmHistoryLength: designSessionSnapshots.llmHistoryLength,
        createdAt: designSessionSnapshots.createdAt,
      })
      .from(designSessionSnapshots)
      .where(eq(designSessionSnapshots.sessionId, sessionId))
      .orderBy(desc(designSessionSnapshots.seq))

    return rows
  }

  static async getById(id: string): Promise<DesignSessionSnapshot | null> {
    const [row] = await db
      .select()
      .from(designSessionSnapshots)
      .where(eq(designSessionSnapshots.id, id))
      .limit(1)

    return row ?? null
  }

  static async getLatestForStage(
    sessionId: string,
    stage: string,
  ): Promise<DesignSessionSnapshot | null> {
    const [row] = await db
      .select()
      .from(designSessionSnapshots)
      .where(
        and(
          eq(designSessionSnapshots.sessionId, sessionId),
          eq(designSessionSnapshots.stage, stage),
        ),
      )
      .orderBy(desc(designSessionSnapshots.seq))
      .limit(1)

    return row ?? null
  }

  /** Copy every snapshot of one session to another (used by session forking). */
  static async copyToSession(
    fromSessionId: string,
    toSessionId: string,
  ): Promise<number> {
    const rows = await db
      .select()
      .from(designSessionSnapshots)
      .where(eq(designSessionSnapshots.sessionId, fromSessionId))
      .orderBy(asc(designSessionSnapshots.seq))

    if (rows.length === 0) return 0

    await db.insert(designSessionSnapshots).values(
      rows.map((row) => ({
        sessionId: toSessionId,
        stage: row.stage,
        seq: row.seq,
        artifacts: row.artifacts,
        llmHistoryLength: row.llmHistoryLength,
      })),
    )

    return rows.length
  }
}
