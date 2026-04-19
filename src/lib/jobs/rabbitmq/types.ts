/**
 * Worker configuration for connecting to RabbitMQ
 */
export interface WorkerConfig {
  /** Queue name for this worker */
  queueName: string

  /** Routing patterns to bind (e.g., 'jobs.notification.*', 'jobs.#') */
  bindingPatterns: Array<string>

  /** Maximum concurrent jobs */
  concurrency: number

  /** Job timeout in milliseconds */
  timeout: number
}

/**
 * RabbitMQ exchange and queue names
 */
export const RABBITMQ_CONFIG = {
  /** Main topic exchange for job routing */
  EXCHANGE_NAME: 'jobs.topic',

  /** Dead letter exchange for failed jobs */
  DLX_EXCHANGE: 'jobs.dlx',

  /** Dead letter queue */
  DLQ_QUEUE: 'jobs.dead-letter',

  /** Maximum message priority (1-255 in RabbitMQ, we use 10) */
  MAX_PRIORITY: 10,
} as const
