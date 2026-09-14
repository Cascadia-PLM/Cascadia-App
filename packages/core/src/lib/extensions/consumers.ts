// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The `consumed` phase, driven.
 *
 * `lib/events/consumers.ts` owns the mechanics of running one consumer — the
 * cursor claim, the savepoint per event, the deadline, the backoff, the
 * parking. This file owns *which* consumers exist, and it answers from the
 * extension registry rather than from a second registry of its own.
 *
 * The event log is the substrate and this layer sits on top of it:
 * `lib/extensions` depends on `lib/events` for everything it runs. One import
 * goes the other way, deliberately — `publishDomainEvent` calls
 * `dispatchInTransaction`, so the log's publish *is* this layer's
 * in-transaction hook, and that is what makes emitting without dispatching
 * impossible. What was `EventConsumerRegistry` is gone: `defineExtension` with
 * `phase: 'consumed'` is the only way to register a consumer, which is what
 * makes the introspection route answerable — it enumerates one registry, and
 * there is no second place a subscriber could be hiding.
 */

import { isExtensionEnabled } from './enablement'
import {
  ExtensionDispatchError,
  filterMatches,
  stampCausation,
} from './dispatch'
import { ExtensionRegistry } from './registry'
import { EVERY_EVENT } from './types'
import type {
  ConsumedExtension,
  ConsumedExtensionContext,
  EveryEventConsumedExtension,
} from './types'
import type {
  ConsumerRunResult,
  DomainEvent,
  DomainEventConsumer,
  DomainEventDefinition,
  PendingDomainEvent,
  PublishDomainEventInput,
} from '@/lib/events/types'
import type { TransactionClient } from '@/lib/db'
import {
  drainEventConsumer,
  runEventConsumerOnce,
} from '@/lib/events/consumers'
import { publishDomainEvent } from '@/lib/events/publish'
import { eventLogger } from '@/lib/logging/logger'

/**
 * Build the `emit` a `consumed` handler receives: a publish with the causation
 * chain stamped from the event being handled and bounded by the hop cap.
 */
function boundedEmit(
  tx: TransactionClient,
  triggering: DomainEvent,
): ConsumedExtensionContext<Record<string, unknown>>['emit'] {
  return async <TNext extends Record<string, unknown>>(
    definition: DomainEventDefinition<TNext>,
    input: Omit<
      PublishDomainEventInput<TNext>,
      'causationId' | 'correlationId'
    >,
  ): Promise<PendingDomainEvent<TNext>> => {
    const stamped = await stampCausation(tx, definition.type, triggering)
    return publishDomainEvent(tx, definition, {
      ...input,
      causationId: stamped.causationId,
      correlationId: stamped.correlationId,
    })
  }
}

/**
 * Project one `consumed` extension into the shape the event-log runtime runs.
 *
 * The projection is where three extension-level concerns are applied that the
 * runtime knows nothing about: the declarative `when` filter, enablement, and
 * the causation-stamping `emit`. An event the filter rules out is passed over
 * *without* the handler running, and the cursor advances past it. A disabled
 * extension does not run at all: its run returns `disabled` before a
 * transaction opens, and its cursor stays exactly where it was — holding
 * retention's floor there, like a parked one, until it is switched back on or
 * forgotten.
 */
export function asDomainEventConsumer<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
>(
  extension: ConsumedExtension<TPayload> | EveryEventConsumedExtension,
): DomainEventConsumer {
  const everyEvent = extension.on === EVERY_EVENT
  return {
    id: extension.id,
    description: extension.description,
    eventTypes: everyEvent ? '*' : [extension.on.type],
    startAt: extension.startAt,
    batchSize: extension.batchSize,
    handlerTimeoutMs: extension.handlerTimeoutMs,
    // Enablement belongs here, not in the handler, and the difference is a
    // defect rather than a nicety: checked inside the handler — which is where
    // this was — a disabled extension *consumes* each event and advances its
    // cursor, so an instance that switched one off would silently eat the whole
    // backlog and have nothing left to process when it was switched back on.
    // Checked here, the run returns `disabled` before the transaction opens and
    // the cursor stays exactly where it was.
    enabled: () => isExtensionEnabled(extension),
    handler: async (event, ctx) => {
      if (!everyEvent && !filterMatches(extension.when, event.payload)) return
      try {
        // The one place the payload narrowing is asserted rather than proved.
        // It holds because `on` and `handler` were typed together at the
        // registration site and the log validated the payload against that
        // same definition at publish time — so an event of this type carries
        // this payload or it was never written. A runtime re-parse here would
        // re-litigate a contract the publish already enforced.
        await extension.handler({
          event: event as DomainEvent<TPayload>,
          tx: ctx.tx,
          signal: ctx.signal,
          emit: boundedEmit(ctx.tx, event),
        })
      } catch (error) {
        // Wrapped for the same reason as every other phase: the surfaced error
        // names the extension, and a pg code the handler raised cannot reach a
        // retry predicate through it. Here it also lands on the consumer row,
        // so `lastError` reads as the extension's failure rather than as an
        // anonymous one.
        throw new ExtensionDispatchError(extension.id, 'consumed', error)
      }
    },
  }
}

/** Every registered `consumed` extension, as runnable consumers. */
export function registeredEventConsumers(): Array<DomainEventConsumer> {
  return ExtensionRegistry.consumed().map(asDomainEventConsumer)
}

/** Run one batch for one `consumed` extension, by id. */
export async function runConsumedExtensionOnce(
  id: string,
): Promise<ConsumerRunResult | null> {
  const extension = ExtensionRegistry.get(id)
  if (!extension || extension.phase !== 'consumed') return null
  return runEventConsumerOnce(asDomainEventConsumer(extension))
}

/** One polling round over every registered `consumed` extension. */
export async function runRegisteredEventConsumersOnce(
  maxBatches = 10,
): Promise<void> {
  for (const consumer of registeredEventConsumers()) {
    try {
      await drainEventConsumer(consumer, maxBatches)
    } catch (error) {
      // A run-level failure here is infrastructure (connection loss, lock
      // timeout), not a handler error — those are recorded on the row.
      eventLogger.warn(
        { consumer: consumer.id, error },
        'Event consumer run failed',
      )
    }
  }
}

/** How long stopping waits for a run in flight before giving up on it. */
const STOP_DRAIN_MS = 15_000

/**
 * Poll registered `consumed` extensions on an interval. Safe to run in any
 * number of processes — `FOR UPDATE SKIP LOCKED` on the cursor row makes
 * rounds mutually exclusive per consumer.
 *
 * Returns a stop function that resolves once any run in flight has finished —
 * committed its progress or rolled back whole — or the drain window closes.
 */
export function startEventConsumerPolling(
  options: {
    intervalMs?: number
    /**
     * Batches one consumer may drain per tick. The default of ten suits a
     * worker; an app server passes 1 to bound how long a run holds a pooled
     * connection.
     */
    maxBatches?: number
    /**
     * Fraction of the interval to jitter each tick by, 0 to 1. Replicas that
     * started together otherwise poll together forever, contending for the
     * same cursor rows on every tick.
     */
    jitterRatio?: number
  } = {},
): () => Promise<void> {
  const intervalMs = options.intervalMs ?? 2000
  const maxBatches = options.maxBatches ?? 10
  const jitterRatio = Math.min(Math.max(options.jitterRatio ?? 0, 0), 1)
  let running = false
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  let current: Promise<void> | null = null

  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      await runRegisteredEventConsumersOnce(maxBatches)
    } finally {
      running = false
    }
  }

  // A self-rescheduling timeout rather than setInterval, because the delay
  // changes every tick when jitter is on.
  const schedule = (): void => {
    if (stopped) return
    const spread = intervalMs * jitterRatio
    const delay = intervalMs - spread / 2 + Math.random() * spread
    timer = setTimeout(() => {
      current = tick().finally(() => {
        current = null
        schedule()
      })
    }, delay)
    timer.unref()
  }

  // Drain on startup so a backlog accumulated while no poller was running
  // (e.g. dev without the worker) clears immediately.
  current = tick().finally(() => {
    current = null
    schedule()
  })

  eventLogger.info(
    {
      intervalMs,
      maxBatches,
      jitterRatio,
      consumers: ExtensionRegistry.consumed().map((e) => e.id),
    },
    'Event consumer polling started',
  )
  return async () => {
    stopped = true
    if (timer) clearTimeout(timer)
    if (current) {
      await Promise.race([
        current,
        new Promise<void>((resolve) =>
          setTimeout(resolve, STOP_DRAIN_MS).unref(),
        ),
      ])
    }
  }
}
