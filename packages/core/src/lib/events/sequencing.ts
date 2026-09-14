// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { sql } from 'drizzle-orm'
import type { DbInstance } from '@/lib/db'
import { eventLogger } from '@/lib/logging/logger'

/**
 * Advisory lock key ('EVNT') that serialises the commit tails of
 * event-emitting transactions. Taken exclusively by the
 * `domain_events_assign_seq` trigger — inside COMMIT, after everything else
 * the transaction did — and released when the transaction ends.
 */
export const DOMAIN_EVENT_SEQ_LOCK_KEY = 0x45564e54

/** Serialises concurrent `ensureDomainEventSequencing` calls (see below). */
const ENSURE_LOCK_KEY = DOMAIN_EVENT_SEQ_LOCK_KEY + 1

export const DOMAIN_EVENT_SEQ_FUNCTION = 'domain_events_assign_seq'
export const DOMAIN_EVENT_SEQ_TRIGGER = 'domain_events_assign_seq'

/**
 * The trigger function's body — kept as its own constant because it is also
 * what `ensureDomainEventSequencing` compares against `pg_proc.prosrc` to
 * decide whether the installed function is current.
 */
const SEQ_FUNCTION_BODY = `
BEGIN
  PERFORM pg_advisory_xact_lock(${DOMAIN_EVENT_SEQ_LOCK_KEY});
  UPDATE domain_events
     SET seq = nextval('domain_events_sequence')
   WHERE id = NEW.id AND seq IS NULL;
  RETURN NULL;
END
`

const CREATE_FUNCTION_SQL = `CREATE OR REPLACE FUNCTION ${DOMAIN_EVENT_SEQ_FUNCTION}() RETURNS trigger
LANGUAGE plpgsql AS $$${SEQ_FUNCTION_BODY}$$`

const CREATE_TRIGGER_SQL = `CREATE CONSTRAINT TRIGGER ${DOMAIN_EVENT_SEQ_TRIGGER}
  AFTER INSERT ON domain_events
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ${DOMAIN_EVENT_SEQ_FUNCTION}()`

/**
 * The DDL that gives `domain_events.seq` commit-order semantics: a deferred
 * constraint trigger that, when the inserting transaction commits, takes the
 * event-log lock and assigns the next value of `domain_events_sequence`.
 *
 * Why a trigger and not a column default. A default assigns at insert time,
 * and transactions commit in any order, so a reader that has seen seq 6 may
 * still be about to be shown seq 5 — and a cursor that advanced past 6 has
 * lost 5 forever. Deferred constraint triggers run inside COMMIT, after all of
 * the transaction's own work, so the lock is held only for the commit tail —
 * whatever the transaction did before, however long it took — and a
 * transaction that acquires it does so only after the previous holder is
 * fully committed and visible. Hence: for any two committed events, seq order
 * is commit order, and a consumer scanning `seq > cursor` can never skip an
 * event that becomes visible later. Publishers never wait on consumers,
 * consumers never wait on publishers, and a transaction that emits early and
 * then works for seconds holds nothing anyone else needs. A transaction that
 * fails after the trigger ran (a serialization failure at commit, say) leaves
 * a hole in the sequence — a finished transaction, harmless to skip.
 *
 * Why it lives here as well as in a migration. drizzle-kit cannot express
 * triggers, so `db:push` — the dev, CI and test-database path — would leave
 * the table without one, and every event would keep a null seq that no
 * consumer ever reads. Every process that emits or consumes events therefore
 * calls `ensureDomainEventSequencing()` at boot, and the migration carries the
 * same statements for the `db:migrate` path. Both are idempotent.
 */
export const DOMAIN_EVENT_SEQUENCING_SQL: ReadonlyArray<string> = [
  CREATE_FUNCTION_SQL,
  CREATE_TRIGGER_SQL,
]

/**
 * Create the sequencing function and trigger if they are missing or stale.
 * Safe to run on every boot and from any number of processes at once.
 *
 * Serialised on an advisory lock, and deliberately not a bare `CREATE OR
 * REPLACE`: Postgres takes no lock of its own for that statement, so two
 * processes booting together — an API server and a jobs worker, two replicas
 * — replacing the same function at once fail with "tuple concurrently
 * updated" (XX000). The lock makes the second one wait, and the body
 * comparison then makes it a read: nothing is rewritten unless the installed
 * function differs from this build's, so a fleet restart costs one DDL.
 */
export async function ensureDomainEventSequencing(
  executor: DbInstance,
): Promise<void> {
  await executor.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${ENSURE_LOCK_KEY})`)

    const installed = await tx.execute<{ prosrc: string }>(
      sql`SELECT prosrc FROM pg_proc WHERE proname = ${DOMAIN_EVENT_SEQ_FUNCTION}`,
    )
    if (installed[0]?.prosrc !== SEQ_FUNCTION_BODY) {
      await tx.execute(sql.raw(CREATE_FUNCTION_SQL))
    }

    const trigger = await tx.execute(
      sql`SELECT 1 FROM pg_trigger
           WHERE tgname = ${DOMAIN_EVENT_SEQ_TRIGGER}
             AND tgrelid = 'domain_events'::regclass`,
    )
    if (trigger.length === 0) {
      await tx.execute(sql.raw(CREATE_TRIGGER_SQL))
    }
  })
  eventLogger.debug('Domain event sequencing trigger ensured')
}

/**
 * Give every committed event that has no `seq` one. Returns how many.
 *
 * A database provisioned by `db:push` has no trigger until a process ensures
 * it, and anything published in between committed with a null seq that the
 * trigger never revisits — invisible to every consumer's `seq > cursor` scan,
 * and never pruned. Run at boot, after the trigger is ensured, so those rows
 * are delivered rather than stranded.
 *
 * Under the sequencing lock, like the trigger itself, so the seqs assigned here
 * stay in commit order against concurrent emitters: their rows are invisible to
 * this statement until they commit, and the trigger sequences them then. Among
 * the stranded rows themselves order is by occurrence, which is the best there
 * is — they committed before anything recorded when.
 *
 * `ids` scopes it, which only a test needs: the suites share one database, and
 * an unscoped run would sequence another suite's deliberately unsequenced row.
 */
export async function sequenceUnsequencedEvents(
  executor: DbInstance,
  options: { ids?: ReadonlyArray<string> } = {},
): Promise<number> {
  if (options.ids?.length === 0) return 0
  const sequenced = await executor.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${DOMAIN_EVENT_SEQ_LOCK_KEY})`,
    )
    const scoped = options.ids
      ? sql`AND id IN (${sql.join(
          options.ids.map((id) => sql`${id}`),
          sql`, `,
        )})`
      : sql``
    const rows = await tx.execute<{ id: string }>(sql`
      WITH stranded AS (
        SELECT id FROM domain_events
         WHERE seq IS NULL ${scoped}
         ORDER BY occurred_at, id
      )
      UPDATE domain_events AS event
         SET seq = nextval('domain_events_sequence')
        FROM stranded
       WHERE event.id = stranded.id
      RETURNING event.id
    `)
    return rows.length
  })
  if (sequenced > 0) {
    eventLogger.warn(
      { sequenced },
      'Sequenced domain events written while the sequencing trigger was missing',
    )
  }
  return sequenced
}
