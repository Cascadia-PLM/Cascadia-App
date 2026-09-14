// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { defineExtension } from './registry'
import { EVERY_EVENT } from './types'
import type { EveryEventConsumedExtension } from './types'
import type { DomainEvent } from '@/lib/events/types'
import { RabbitMQClient } from '@/lib/jobs/rabbitmq/client'
import { TransientConsumerError } from '@/lib/events/consumers'

export const RABBITMQ_EVENT_RELAY_ID = 'relay.rabbitmq'

export interface RabbitMqEventRelayOptions {
  /**
   * Injectable for tests; defaults to the shared RabbitMQ client.
   *
   * Takes the run's abort signal, which is the second half of the deadline
   * story: without it the deadline bounded the consumer's cursor lock but not
   * the publish itself, so a broker that accepted a frame and then went quiet
   * held the lock until the handler timeout with nothing to interrupt it.
   */
  publish?: (
    routingKey: string,
    event: DomainEvent,
    signal: AbortSignal,
  ) => Promise<void>
}

/**
 * The broker is a consumer, not the bus.
 *
 * This relay reads the Postgres event log like any other `consumed` extension
 * and re-publishes each event to the `cascadia.events` topic exchange (routing
 * key = event type) for external subscribers. Because the log is the source of
 * truth, a broker outage costs latency, never events: the relay's cursor stops,
 * the outage ends, the relay catches up in order. Deployments without RabbitMQ
 * simply do not register it.
 *
 * Delivery to the exchange is at-least-once (the cursor advances after a
 * successful publish); subscribers dedupe on the envelope `id`.
 *
 * **It is an extension rather than a bespoke consumer**, and that is the point
 * of re-expressing it: it was the only registered consumer anywhere, so as long
 * as it lived in a registry of its own the introspection route could answer for
 * only half the system. One registry, one answer. It is also the first proof
 * that the wildcard `consumed` arm carries real weight rather than existing for
 * a hypothetical subscriber — the webhook fan-out in a later stage is the
 * second.
 */
export function createRabbitMqEventRelay(
  options: RabbitMqEventRelayOptions = {},
): EveryEventConsumedExtension {
  const publish =
    options.publish ??
    ((routingKey: string, event: DomainEvent, signal: AbortSignal) =>
      RabbitMQClient.publishDomainEvent(routingKey, event, signal))

  return {
    id: RABBITMQ_EVENT_RELAY_ID,
    description:
      'Relays committed domain events to the cascadia.events topic exchange',
    phase: 'consumed',
    on: EVERY_EVENT,
    handler: async ({ event, signal }) => {
      try {
        await publish(event.type, event, signal)
      } catch (error) {
        // An abort is the runtime's own deadline, which it records as a
        // timeout. Anything else is the broker — an outage rather than a
        // poison event, since nothing about one envelope makes a broker refuse
        // it on its merits — so the relay retries rather than parks, and an
        // outage costs latency, never an administrator's resume.
        if (signal.aborted) throw error
        throw new TransientConsumerError(
          'Relaying the event to RabbitMQ failed',
          { cause: error },
        )
      }
    },
  }
}

/**
 * Register the relay. Called by the jobs worker, which is the process that
 * owns broker connectivity — not at import time, so a deployment without
 * RabbitMQ never registers a consumer that cannot connect.
 */
export function registerRabbitMqEventRelay(
  options: RabbitMqEventRelayOptions = {},
): void {
  defineExtension(createRabbitMqEventRelay(options))
}
