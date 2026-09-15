// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ZodError } from 'zod'
import { EventTypeRegistry } from './registry'
import type { TransactionClient } from '@/lib/db'
import type { DomainEventRow } from '@/lib/db/schema'
import type {
  DomainEvent,
  DomainEventDefinition,
  PendingDomainEvent,
  PublishDomainEventInput,
} from './types'
import { dispatchInTransaction } from '@/lib/extensions/dispatch'
import { ValidationError } from '@/lib/errors'
import { takeFirst } from '@/lib/db/take-first'
import { domainEvents } from '@/lib/db/schema'

/**
 * Declare a domain event type. Registers the definition in
 * `EventTypeRegistry` as a side effect, so importing a definition is enough
 * to have it in the catalog.
 */
export function defineDomainEvent<TPayload extends Record<string, unknown>>(
  definition: DomainEventDefinition<TPayload>,
): DomainEventDefinition<TPayload> {
  EventTypeRegistry.register(definition)
  return definition
}

/**
 * Append a domain event to the log, inside the caller's transaction.
 *
 * This is a transactional outbox write: the event commits if and only if the
 * surrounding mutation commits, so the log can never show a phantom event or
 * miss a committed change. Callers without a transaction wrap the call —
 * `withTx(undefined, (tx) => publishDomainEvent(tx, ...))` — and accept that
 * only the emit itself is atomic.
 *
 * The row is inserted with a null `seq`; the sequencing trigger assigns it
 * when the transaction commits (see `sequencing.ts`), which is why the
 * returned envelope carries no `seq`. Nothing is locked here and nothing
 * waits on anyone: a publisher pays one insert, whenever in its transaction
 * it chooses to emit.
 *
 * The payload is validated against the definition's schema; a mismatch
 * throws `ValidationError` and rolls back with everything else.
 */
export async function publishDomainEvent<
  TPayload extends Record<string, unknown>,
>(
  tx: TransactionClient,
  definition: DomainEventDefinition<TPayload>,
  input: PublishDomainEventInput<TPayload>,
): Promise<PendingDomainEvent<TPayload>> {
  if (!EventTypeRegistry.hasType(definition.type)) {
    EventTypeRegistry.register(definition)
  }

  let payload: TPayload
  try {
    payload = definition.payloadSchema.parse(input.payload)
  } catch (error) {
    if (error instanceof ZodError) {
      throw ValidationError.fromZodError(error, {
        operation: 'publishDomainEvent',
        resource: definition.type,
      })
    }
    throw error
  }

  const row = takeFirst(
    await tx
      .insert(domainEvents)
      .values({
        type: definition.type,
        schemaVersion: definition.schemaVersion,
        actorId: input.actorId ?? null,
        subjectType: input.subject?.type ?? definition.subjectType ?? null,
        subjectId: input.subject?.id ?? null,
        subjectMasterId: input.subject?.masterId ?? null,
        programId: input.context?.programId ?? null,
        designId: input.context?.designId ?? null,
        branchId: input.context?.branchId ?? null,
        payload: payload as Record<string, unknown>,
        correlationId: input.correlationId ?? null,
        causationId: input.causationId ?? null,
      })
      .returning(),
    'domain event',
  )

  const { seq: _unsequenced, ...pending } = rowToEnvelope<TPayload>(row)

  // The `in-transaction` phase dispatches here, in one call with the publish,
  // rather than at each emission site. Two properties follow from that and
  // neither is available if a site has to remember: the log cannot disagree
  // with what a handler saw, because the row is already written when the
  // handler runs and both commit together; and no site can emit without
  // dispatching, at any emission site, each of which would otherwise have been
  // a chance to forget.
  //
  // A handler's throw propagates, wrapped, and rolls this transaction back
  // with the event and the mutation that caused it — which is what the phase
  // means.
  await dispatchInTransaction(tx, definition, pending)

  return pending
}

function rowToEnvelope<TPayload extends Record<string, unknown>>(
  row: DomainEventRow,
): Omit<DomainEvent<TPayload>, 'seq'> & { seq: number | null } {
  return {
    id: row.id,
    seq: row.seq,
    type: row.type,
    schemaVersion: row.schemaVersion,
    occurredAt: row.occurredAt,
    actorId: row.actorId,
    subject: {
      type: row.subjectType,
      id: row.subjectId,
      masterId: row.subjectMasterId,
    },
    context: {
      programId: row.programId,
      designId: row.designId,
      branchId: row.branchId,
    },
    payload: row.payload as TPayload,
    correlationId: row.correlationId,
    causationId: row.causationId,
  }
}

/**
 * Reshape a committed `domain_events` row into the envelope consumers
 * receive. A null `seq` cannot reach here from a consumer scan (`seq >
 * cursor` excludes it); it is rejected rather than coerced so that a caller
 * reading its own uncommitted rows learns the difference.
 */
export function rowToDomainEvent<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
>(row: DomainEventRow): DomainEvent<TPayload> {
  const envelope = rowToEnvelope<TPayload>(row)
  if (envelope.seq === null) {
    throw new Error(
      `Domain event ${row.id} has no seq yet: its transaction has not committed`,
    )
  }
  return { ...envelope, seq: envelope.seq }
}

/**
 * Narrow an envelope to a definition's payload type. Payloads were validated
 * at publish time, so a type match is sufficient.
 */
export function isDomainEventOfType<TPayload extends Record<string, unknown>>(
  event: DomainEvent,
  definition: DomainEventDefinition<TPayload>,
): event is DomainEvent<TPayload> {
  return event.type === definition.type
}
