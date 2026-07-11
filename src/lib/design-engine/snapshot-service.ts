// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Design Session Snapshot Service
 *
 * Append-only snapshots of a session's artifacts, captured at every
 * review-gate confirmation. They are the diff bases for review stages and
 * the restore targets for reopen_stage.
 */

import { and, asc, desc, eq } from 'drizzle-orm'
import type { DesignArtifacts } from './types'
import { db } from '@/lib/db'
import { designSessionSnapshots } from '@/lib/db/schema/design-engine'

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

export class DesignSnapshotService {
  static async create(
    sessionId: string,
    stage: string,
    artifacts: DesignArtifacts,
    llmHistoryLength: number,
  ): Promise<DesignSessionSnapshot> {
    return db.transaction(async (tx) => {
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

    return (row as DesignSessionSnapshot | undefined) ?? null
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

    return (row as DesignSessionSnapshot | undefined) ?? null
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
