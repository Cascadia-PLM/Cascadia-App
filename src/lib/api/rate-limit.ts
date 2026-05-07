/**
 * In-memory sliding window rate limiter.
 *
 * Tracks request timestamps per key (typically client IP) and rejects
 * requests that exceed the configured limit within the window.
 *
 * Suitable for single-instance deployments. For multi-instance deployments
 * behind a load balancer, each instance maintains independent counters —
 * acceptable for abuse prevention, not precise metering.
 */

export interface RateLimitConfig {
  /** Time window in milliseconds */
  windowMs: number
  /** Maximum requests allowed per window */
  maxRequests: number
}

interface RateLimitEntry {
  timestamps: Array<number>
}

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(private config: RateLimitConfig) {
    // Periodically evict expired entries to prevent memory leaks
    this.cleanupTimer = setInterval(() => this.cleanup(), config.windowMs)
    // Allow the process to exit without waiting for this timer
    this.cleanupTimer.unref()
  }

  check(key: string): { allowed: boolean; retryAfterSeconds?: number } {
    const now = Date.now()
    const windowStart = now - this.config.windowMs

    let entry = this.store.get(key)
    if (!entry) {
      entry = { timestamps: [] }
      this.store.set(key, entry)
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart)

    if (entry.timestamps.length >= this.config.maxRequests) {
      // Oldest timestamp in window determines when the next slot opens
      const oldestInWindow = entry.timestamps[0]
      const retryAfterMs = oldestInWindow + this.config.windowMs - now
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      }
    }

    entry.timestamps.push(now)
    return { allowed: true }
  }

  private cleanup(): void {
    const windowStart = Date.now() - this.config.windowMs
    for (const [key, entry] of this.store) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart)
      if (entry.timestamps.length === 0) {
        this.store.delete(key)
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer)
    this.store.clear()
  }
}

/** Strict limiter for login and password endpoints */
export const loginLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 10,
})

/** General API limiter */
export const apiLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 1_000,
})

/** File upload limiter */
export const uploadLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: 100,
})

/**
 * Extract client IP from request headers.
 * Checks X-Forwarded-For (set by reverse proxies) first.
 */
export function getClientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) {
    // Take the first IP (original client) from the chain
    return forwarded.split(',')[0].trim()
  }
  const realIp = request.headers.get('x-real-ip')
  if (realIp) {
    return realIp.trim()
  }
  return 'unknown'
}
