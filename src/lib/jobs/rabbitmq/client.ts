import amqp from 'amqplib'
import { RABBITMQ_CONFIG } from './types'
import type { Channel, ConsumeMessage } from 'amqplib'
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
      this.connection = null
      this.channel = null
    })

    conn.on('close', () => {
      rabbitmqLogger.warn('Connection closed')
      this.connection = null
      this.channel = null
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
   * Close connection gracefully.
   */
  static async close(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close()
        this.channel = null
      }
      if (this.connection) {
        await this.connection.close()
        this.connection = null
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

  /**
   * Acknowledge a message.
   */
  static ack(msg: ConsumeMessage): void {
    if (this.channel) {
      this.channel.ack(msg)
    }
  }

  /**
   * Negative acknowledge - requeue or send to DLX.
   */
  static nack(msg: ConsumeMessage, requeue = false): void {
    if (this.channel) {
      this.channel.nack(msg, false, requeue)
    }
  }
}
