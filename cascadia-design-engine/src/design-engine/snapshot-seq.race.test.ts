// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Snapshot sequence numbers under real concurrency
 *
 * Data-integrity gate. A snapshot's `seq` is the session's ordering, and it
 * was minted by reading `max(seq)` and inserting `seq + 1` inside a default
 * READ COMMITTED transaction — which does not stop a second transaction
 * reading the same maximum. Two confirms could therefore mint the same number,
 * and `getLatestForStage` — the diff base a review stage renders against and
 * the state `reopen_stage` restores — then picked between the tied rows by row
 * order. Rolling back would silently land on either.
 *
 * `uq_design_snapshots_session_seq` makes the second insert fail instead, and
 * `create` retries: the loser re-reads the maximum and lands on the next free
 * value. Only real connections can show that. Under `TestDatabase` every
 * caller queues on one connection, so the tie cannot occur and the retry never
 * runs. Design sessions cascade from their user, and snapshots from their
 * session, so the harness's cleanup covers both.
 *
 * Run: npx vitest run cascadia-design-engine/src/design-engine/snapshot-seq.race.test.ts
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import type { DesignArtifacts } from '@/design-engine/types'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { DesignSessionService } from '@/design-engine/session-service'
import { DesignSnapshotService } from '@/design-engine/snapshot-service'
import { designSessionSnapshots } from '@/db/schema/design-engine'
import { asPostgresError, constraintOf } from '@/errors/pg'

/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505'

/** Fewer than the harness's five pooled connections, so they contend rather than queue. */
const CONFIRMS = 4

const STAGE = 'bom_review'

/** The smallest artifacts blob the type admits; its contents are irrelevant here. */
function artifacts(note: string): DesignArtifacts {
  return {
    description: note,
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }
}

describe('DesignSnapshotService.create — concurrent snapshots', () => {
  const concurrent = new ConcurrentTestDatabase()

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    await concurrent.cleanup()
  })

  async function session(label: string) {
    const { user, programId } = await concurrent.seedScope(label)
    return DesignSessionService.create(user.id, {
      description: `snapshot ${label}`,
      programId,
    })
  }

  it('gives four simultaneous confirms four consecutive sequence numbers', async () => {
    const created = await session('snapshot-seq')

    await Promise.all(
      Array.from({ length: CONFIRMS }, (_, i) =>
        DesignSnapshotService.create(
          created.id,
          STAGE,
          artifacts(`confirm ${i}`),
          i,
        ),
      ),
    )

    const rows = await concurrent.db
      .select({ seq: designSessionSnapshots.seq })
      .from(designSessionSnapshots)
      .where(eq(designSessionSnapshots.sessionId, created.id))

    // Every confirm is recorded, and no two of them claim one position in the
    // session's history.
    expect(rows).toHaveLength(CONFIRMS)
    const seqs = rows.map((row) => row.seq).sort((a, b) => a - b)
    expect(seqs).toEqual([1, 2, 3, 4])
  })

  it('leaves exactly one latest snapshot for the stage after concurrent confirms', async () => {
    const created = await session('snapshot-latest')

    await Promise.all(
      Array.from({ length: CONFIRMS }, (_, i) =>
        DesignSnapshotService.create(
          created.id,
          STAGE,
          artifacts(`confirm ${i}`),
          i,
        ),
      ),
    )

    // The whole point of the number: the diff base and the rollback target are
    // a single unambiguous row, not whichever of a tied pair came back first.
    const latest = await DesignSnapshotService.getLatestForStage(
      created.id,
      STAGE,
    )
    expect(latest?.seq).toBe(CONFIRMS)

    const atTop = await concurrent.db
      .select({ id: designSessionSnapshots.id })
      .from(designSessionSnapshots)
      .where(
        and(
          eq(designSessionSnapshots.sessionId, created.id),
          eq(designSessionSnapshots.seq, CONFIRMS),
        ),
      )
    expect(atTop.map((row) => row.id)).toEqual([latest?.id])
  })

  it('rejects a duplicate (session, seq) written straight to the table', async () => {
    const created = await session('snapshot-pin')

    await DesignSnapshotService.create(created.id, STAGE, artifacts('pin'), 0)

    let caught: unknown
    try {
      await concurrent.db.insert(designSessionSnapshots).values({
        sessionId: created.id,
        stage: STAGE,
        seq: 1,
        artifacts: artifacts('duplicate'),
        llmHistoryLength: 0,
      })
    } catch (error) {
      caught = error
    }

    const pgError = asPostgresError(caught)
    expect(pgError?.code).toBe(UNIQUE_VIOLATION)
    expect(constraintOf(pgError!)).toBe('uq_design_snapshots_session_seq')
  })
})
