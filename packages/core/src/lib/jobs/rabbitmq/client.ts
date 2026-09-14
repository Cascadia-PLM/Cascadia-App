// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import amqp from 'amqplib'
import { RABBITMQ_CONFIG } from './types'
import type { Channel, ConfirmChannel } from 'amqplib'
import type { JobMessage } from '../types'
import { rabbitmqLogger } from '@/lib/logging/logger'
import { redactUrlCredentials } from '@/lib/logging/redact-url'

const {
  EXCHANGE_NAME,
  DLX_EXCHANGE,
  DLQ_QUEUE,
  EVENTS_EXCHANGE,
  MAX_PRIORITY,
} = RABBITMQ_CONFIG

// amqplib returns ChannelModel from connect(), but the @types/amqplib package
// has some inconsistencies. We use a looser type to work around this.
type AmqpConnection = Awaited<ReturnType<typeof amqp.connect>>

/**
 * RabbitMQ connection and publishing client.
 * Singleton pattern with lazy connection.
 */
export class RabbitMQClient {
  private static connection: AmqpConnection | null = null
  private static channel: Channel | null = null
  /**
   * A second channel, in **confirm** mode, for the domain event relay.
   *
   * Separate from the job channel because confirm mode is a channel-level
   * property and jobs do not want per-message round trips. Created lazily, so a
   * deployment that never relays never opens it, and nulled on every teardown
   * path below — a publish into a dead channel gets a callback that never fires,
   * and the only thing that would end that hang is the handler deadline.
   */
  private static confirmChannel: ConfirmChannel | null = null
  private static isConnecting = false
  private static connectionPromise: Promise<void> | null = null
  private static onConnectionLost: (() => void) | null = null

  /**
   * Register the one callback fired when an established connection drops.
   *
   * Worker-context only: `JobWorker.start` wires its reconnect loop here,
   * while the API server deliberately stays unwired — it keeps the lazy
   * reconnect-on-publish behavior (the next `publish` finds no connection
   * and re-dials), and giving every web process a broker supervision loop
   * would be a job none of them wants.
   */
  static setOnConnectionLost(callback: (() => void) | null): void {
    this.onConnectionLost = callback
  }

  /**
   * amqplib fires 'error' and then 'close' for the same loss; whichever
   * lands first nulls the refs and fires the callback, and the second finds
   * them already null and does nothing.
   */
  private static handleConnectionLoss(): void {
    if (this.connection === null && this.channel === null) return
    this.connection = null
    this.channel = null
    this.onConnectionLost?.()
  }

  /**
   * Initialize connection to RabbitMQ.
   * Safe to call multiple times - will reuse existing connection.
   */
  static async connect(): Promise<void> {
    if (this.connection && this.channel) {
      return
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise
    }

    this.isConnecting = true
    this.connectionPromise = this.doConnect()

    try {
      await this.connectionPromise
    } finally {
      this.isConnecting = false
      this.connectionPromise = null
    }
  }

  private static async doConnect(): Promise<void> {
    const url = process.env.RABBITMQ_URL || 'amqp://localhost:5672'
    // Never the raw URL: it carries the broker password.
    rabbitmqLogger.info({ url: redactUrlCredentials(url) }, 'Connecting')

    const conn = await amqp.connect(url)
    this.connection = conn
    this.channel = await conn.createChannel()

    // Set up main topic exchange
    await this.channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true })

    // Set up dead letter exchange and queue
    await this.channel.assertExchange(DLX_EXCHANGE, 'fanout', { durable: true })
    await this.channel.assertQueue(DLQ_QUEUE, { durable: true })
    await this.channel.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, '')

    // Domain event fan-out exchange (no queues asserted here — consumers own
    // their bindings)
    await this.channel.assertExchange(EVENTS_EXCHANGE, 'topic', {
      durable: true,
    })

    // Handle connection errors
    conn.on('error', (err: Error) => {
      rabbitmqLogger.error({ err }, 'Connection error')
      this.confirmChannel = null
      this.handleConnectionLoss()
    })

    conn.on('close', () => {
      rabbitmqLogger.warn('Connection closed')
      this.confirmChannel = null
      this.handleConnectionLoss()
    })

    rabbitmqLogger.info('Connected and exchanges set up')
  }

  /**
   * Publish a job message to the exchange.
   */
  static async publish(routingKey: string, message: JobMessage): Promise<void> {
    await this.connect()

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available')
    }

    const content = Buffer.from(JSON.stringify(message))

    const published = this.channel.publish(EXCHANGE_NAME, routingKey, content, {
      persistent: true,
      priority: message.priority,
      messageId: message.jobId,
      timestamp: Date.now(),
      contentType: 'application/json',
      headers: {
        'x-attempt': message.attemptNumber,
        'x-job-type': message.type,
      },
    })

    if (!published) {
      throw new Error('Failed to publish message - channel buffer full')
    }

    rabbitmqLogger.info({ jobId: message.jobId, routingKey }, 'Published job')
  }

  /** The relay's confirm channel, opened on first use. */
  private static async getConfirmChannel(): Promise<ConfirmChannel> {
    await this.connect()
    if (this.confirmChannel) return this.confirmChannel
    if (!this.connection) {
      throw new Error('RabbitMQ connection not available')
    }
    const channel = await this.connection.createConfirmChannel()
    // A channel can die without its connection doing so — a publish to a
    // missing exchange closes it with a 404 — and an `error` event with no
    // listener is an uncaught exception, which exits the jobs worker. Either
    // way the channel is finished: forget it, so the next publish opens a fresh
    // one instead of throwing on a dead handle until the connection reconnects.
    channel.on('error', (err: Error) => {
      rabbitmqLogger.error({ err }, 'Confirm channel error')
      if (this.confirmChannel === channel) this.confirmChannel = null
    })
    channel.on('close', () => {
      if (this.confirmChannel === channel) this.confirmChannel = null
    })
    await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true })
    this.confirmChannel = channel
    return channel
  }

  /**
   * Publish a domain event envelope to the events topic exchange, and wait for
   * the broker to confirm it.
   *
   * **Why the confirm matters.** This used to publish on the shared
   * non-confirm channel and return as soon as amqplib accepted the buffer — and
   * the relay awaits this before the consumer transaction commits its cursor.
   * So the cursor advanced on *buffer acceptance* rather than broker
   * persistence, and a broker dying with unflushed frames lost those events
   * permanently. That is the one loss mode this whole design exists to prevent.
   *
   * Per-message rather than a batched `waitForConfirms`: the cursor advances per
   * event inside a savepoint loop, and a batch confirm makes a partial failure
   * ambiguous about which event to stop before.
   *
   * The old "channel buffer full" throw is gone, and why matters — under
   * confirms the message is still buffered and its callback still fires, and
   * because the relay awaits each confirm before publishing the next, that await
   * *is* the back-pressure.
   */
  static async publishDomainEvent(
    routingKey: string,
    envelope: { id: string; occurredAt: Date; type: string },
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Aborted before publishing event')
    }
    const channel = await this.getConfirmChannel()
    const content = Buffer.from(JSON.stringify(envelope))

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const onAbort = () =>
        finish(new Error('Aborted while awaiting a broker confirm'))
      signal?.addEventListener('abort', onAbort, { once: true })

      channel.publish(
        EVENTS_EXCHANGE,
        routingKey,
        content,
        {
          persistent: true,
          messageId: envelope.id,
          timestamp: envelope.occurredAt.getTime(),
          contentType: 'application/json',
          headers: { 'x-event-type': envelope.type },
        },
        (error) => {
          // amqplib's callback is the ack/nack: an error here is a nack or a
          // channel that died, and either means the broker does not have it.
          finish(
            error instanceof Error
              ? error
              : error
                ? new Error(String(error))
                : undefined,
          )
        },
      )
    })
  }

  /**
   * Create a queue and bind it to routing patterns.
   * Returns a channel for consuming messages.
   */
  static async createQueue(
    queueName: string,
    bindingPatterns: Array<string>,
    options: {
      maxPriority?: number
      prefetch?: number
    } = {},
  ): Promise<Channel> {
    await this.connect()

    if (!this.channel) {
      throw new Error('RabbitMQ channel not available')
    }

    // Assert queue with priority support and DLX
    await this.channel.assertQueue(queueName, {
      durable: true,
      maxPriority: options.maxPriority ?? MAX_PRIORITY,
      deadLetterExchange: DLX_EXCHANGE,
    })

    // Bind to all patterns
    for (const pattern of bindingPatterns) {
      await this.channel.bindQueue(queueName, EXCHANGE_NAME, pattern)
      rabbitmqLogger.info({ queue: queueName, pattern }, 'Bound queue')
    }

    // Set prefetch (concurrency limit)
    await this.channel.prefetch(options.prefetch ?? 1)

    return this.channel
  }

  /**
   * Get the current channel (for consuming).
   */
  static getChannel(): Channel | null {
    return this.channel
  }

  /**
   * How many messages are sitting in `queueName`, or null when the broker
   * cannot answer.
   *
   * `checkQueue` is a *passive* declare: it reads a queue's depth without
   * saying anything about how it should be configured, so it can never drift
   * from what `doConnect` asserted. That distinction is the whole reason the
   * dead-letter queue has no `x-max-length` — an `assertQueue` whose arguments
   * differ from an existing durable queue is answered with 406
   * PRECONDITION_FAILED, so bounds are an operator policy the broker applies
   * without a redeclaration (see docs/orchestration/configuration.md).
   *
   * It runs on a channel of its own, opened and closed per call, because a
   * passive declare of a queue that does not exist is a channel-level 404: the
   * broker closes the channel, and doing that to the shared publish channel
   * would take publishing down with a health poll. The 'error' listener is not
   * decoration either — an unhandled 'error' event on an EventEmitter throws,
   * and the worker exits 1 on an uncaught exception.
   *
   * It deliberately does **not** call `connect()`. Using only an established
   * connection is what guarantees `doConnect` has already asserted the queue,
   * and — since this is called from a health poll — it keeps an observability
   * read from dialing the broker: a reconnect from here would flip
   * `isConnected()` back to true while the worker's consumer was still gone,
   * and the health endpoint would report a worker that consumes nothing as
   * healthy. No connection therefore means "unknown".
   *
   * Never throws. Depth is an observability signal, so a broker that cannot
   * answer means "unknown", not "unhealthy".
   */
  static async getQueueDepth(queueName: string): Promise<number | null> {
    const connection = this.connection
    if (!connection) return null

    let channel: Channel | null = null
    try {
      channel = await connection.createChannel()
      // The rejected checkQueue below is this error's report; the listener is
      // only here so the emit does not become an uncaught exception.
      channel.on('error', () => undefined)
      const { messageCount } = await channel.checkQueue(queueName)
      return messageCount
    } catch (error) {
      rabbitmqLogger.warn(
        { err: error, queue: queueName },
        'Could not read queue depth',
      )
      return null
    } finally {
      if (channel) {
        try {
          await channel.close()
        } catch {
          // A failed passive declare already closed it; nothing left to do.
        }
      }
    }
  }

  /**
   * Close connection gracefully.
   */
  static async close(): Promise<void> {
    // Take the refs down before closing: the driver fires 'close' during the
    // awaits below, and handleConnectionLoss must find an already-cleared
    // client so a deliberate shutdown never masquerades as a connection loss.
    const channel = this.channel
    const confirmChannel = this.confirmChannel
    const connection = this.connection
    this.channel = null
    this.confirmChannel = null
    this.connection = null
    try {
      if (confirmChannel) {
        await confirmChannel.close()
      }
      if (channel) {
        await channel.close()
      }
      if (connection) {
        await connection.close()
      }
      rabbitmqLogger.info('Connection closed')
    } catch (error) {
      rabbitmqLogger.error({ err: error }, 'Error closing connection')
    }
  }

  /**
   * Get connection status.
   */
  static isConnected(): boolean {
    return this.connection !== null && this.channel !== null
  }
}
