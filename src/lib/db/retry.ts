/**
 * Retry wrapper for SERIALIZABLE transactions.
 *
 * PostgreSQL raises error code 40001 (serialization_failure) when two
 * concurrent SERIALIZABLE transactions conflict. This wrapper retries
 * with exponential backoff, which is the standard mitigation.
 */
export async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? (error as { code: string }).code
          : null
      if (code !== '40001' || attempt === maxRetries) throw error
      await new Promise((r) => setTimeout(r, 50 * Math.pow(2, attempt)))
    }
  }
  throw new Error('Unreachable')
}
