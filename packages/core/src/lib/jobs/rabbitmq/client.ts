// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import amqp from 'amqplib'
import { RABBITMQ_CONFIG } from './types'
import type { Channel } from 'amqplib'
import type { JobMessage } from '../types'
import { rabbitmqLogger } from '@/lib/logging/logger'

const { EXCHANGE_NAME, DLX_EXCHANGE, DLQ_QUEUE, MAX_PRIORITY } = RABBITMQ_CONFIG

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
    rabbitmqLogger.info({ url }, 'Connecting')

    const conn = await amqp.connect(url)
    this.connection = conn
    this.channel = await conn.createChannel()

    // Set up main topic exchange
    await this.channel.assertExchange(EXCHANGE_NAME, 'topic', { durable: true })

    // Set up dead letter exchange and queue
    await this.channel.assertExchange(DLX_EXCHANGE, 'fanout', { durable: true })
    await this.channel.assertQueue(DLQ_QUEUE, { durable: true })
    await this.channel.bindQueue(DLQ_QUEUE, DLX_EXCHANGE, '')

    // Handle connection errors
    conn.on('error', (err: Error) => {
      rabbitmqLogger.error({ err }, 'Connection error')
      this.handleConnectionLoss()
    })

    conn.on('close', () => {
      rabbitmqLogger.warn('Connection closed')
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
    const connection = this.connection
    this.channel = null
    this.connection = null
    try {
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
