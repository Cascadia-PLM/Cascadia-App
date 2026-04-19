import { ErrorCode } from './codes'

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  maxAttempts: number
  initialDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
}

/**
 * Default retry configuration.
 */
export const defaultRetryConfig: RetryConfig = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
}

/**
 * Error codes that should be automatically retried.
 */
const retryableErrors = new Set<ErrorCode>([
  ErrorCode.RATE_LIMITED,
  ErrorCode.DB_CONNECTION_FAILED,
  ErrorCode.EXTERNAL_SERVICE_UNAVAILABLE,
  ErrorCode.EXTERNAL_SERVICE_TIMEOUT,
])

/**
 * Check if an error code is retryable.
 */
export function isRetryableError(code: ErrorCode): boolean {
  return retryableErrors.has(code)
}

/**
 * Calculate the delay before the next retry attempt.
 * Uses exponential backoff with jitter.
 *
 * @param attempt - The current attempt number (1-based)
 * @param config - Optional retry configuration
 * @returns The delay in milliseconds
 */
export function getRetryDelay(
  attempt: number,
  config: RetryConfig = defaultRetryConfig,
): number {
  // Exponential backoff: delay = initialDelay * multiplier^(attempt-1)
  const delay =
    config.initialDelayMs * Math.pow(config.backoffMultiplier, attempt - 1)

  // Add jitter (±20%) to prevent thundering herd
  const jitter = delay * 0.2 * (Math.random() * 2 - 1)

  // Cap at max delay
  return Math.min(delay + jitter, config.maxDelayMs)
}

/**
 * Sleep for a specified duration.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Execute an async function with retry logic.
 *
 * @param fn - The async function to execute
 * @param shouldRetry - Function to determine if an error should be retried
 * @param config - Optional retry configuration
 * @returns The result of the function
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  shouldRetry: (error: unknown) => boolean,
  config: RetryConfig = defaultRetryConfig,
): Promise<T> {
  let lastError: unknown

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error

      // Check if we should retry
      if (attempt < config.maxAttempts && shouldRetry(error)) {
        const delay = getRetryDelay(attempt, config)
        await sleep(delay)
        continue
      }

      throw error
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError
}
