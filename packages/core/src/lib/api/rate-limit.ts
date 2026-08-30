// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
      const retryAfterMs =
        oldestInWindow === undefined
          ? this.config.windowMs
          : oldestInWindow + this.config.windowMs - now
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

/**
 * Read a per-minute request budget from the environment.
 *
 * These are per-instance and keyed by client IP, so the right value depends on
 * the deployment: every user behind one corporate NAT egress shares a bucket,
 * and a single SPA page load spends many requests at once. Hence configurable
 * rather than a constant someone has to fork the code to change.
 *
 * An unset, unparseable, or non-positive value falls back to the default — a
 * typo in a deployment env should not silently remove the limit.
 */
function limitFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[rate-limit] Ignoring ${name}="${raw}" — expected a positive number; using ${fallback}`,
    )
    return fallback
  }
  return Math.floor(parsed)
}

/** Strict limiter for login and password endpoints */
export const loginLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: limitFromEnv('RATE_LIMIT_LOGIN_PER_MINUTE', 10),
})

/** General API limiter, applied to every route that does not opt out */
export const apiLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: limitFromEnv('RATE_LIMIT_API_PER_MINUTE', 1_000),
})

/** File upload limiter */
export const uploadLimiter = new RateLimiter({
  windowMs: 60_000,
  maxRequests: limitFromEnv('RATE_LIMIT_UPLOAD_PER_MINUTE', 100),
})

/*
 * Keying is not this module's job. `getClientIp` used to live here and read
 * the leftmost `X-Forwarded-For` entry — a value the caller writes, so
 * rotating it minted a fresh bucket per request and the budget above stopped
 * meaning anything. `resolveClientIp` in `./client-ip` replaced it: it trusts
 * only as many forwarded hops as `TRUSTED_PROXY_COUNT` declares, and otherwise
 * the TCP peer address.
 */
