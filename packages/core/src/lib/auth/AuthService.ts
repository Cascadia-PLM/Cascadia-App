// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AuthService
 *
 * Handles authentication operations like login and logout.
 * Extracted from route handlers to enable unit testing.
 */

import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { authEvents, users } from '@/lib/db/schema'
import {
  hashPassword,
  hashSessionToken,
  needsRehash,
  verifyPassword,
} from '@/lib/auth/password'
import { SessionManager } from '@/lib/auth/session'
import {
  AccountLockedError,
  AuthenticationError,
  ValidationError,
} from '@/lib/errors'
import { takeFirst } from '@/lib/db/take-first'

export interface LoginInput {
  username: string
  password: string
  ipAddress?: string
  userAgent?: string
}

export interface LoginResult {
  success: true
  sessionToken: string
  user: {
    id: string
    email: string
    name: string | null
  }
}

export interface LogoutInput {
  sessionToken: string
  ipAddress?: string
}

export interface LogoutResult {
  success: true
}

/**
 * Which password prompt a failed attempt came from.
 *
 * Recorded in the `auth_events` metadata so an administrator reading a
 * lockout can tell a login spray apart from a signer mistyping their password
 * on an approval ten times. Both spend the same budget — see
 * {@link AuthService.recordFailedPasswordAttempt}.
 */
export type PasswordAttemptSource = 'login' | 'signature'

/**
 * Service for handling authentication operations.
 */
export class AuthService {
  /** Maximum consecutive failed password attempts before lockout */
  static readonly MAX_FAILED_ATTEMPTS = 10

  /** Lockout duration in minutes */
  static readonly LOCKOUT_DURATION_MINUTES = 15

  // ============================================
  // Lockout policy
  //
  // Every path that checks an account password shares one budget, so these
  // live here rather than inline in `login()`. The three writes below all go
  // to the module-level `db` handle and deliberately take no `tx`: a caller
  // that is inside a transaction which is about to roll back (the approval
  // signature path is exactly that) must still leave the counter behind, or
  // the failure erases its own record and the lockout never engages. On the
  // pooled handle each of these lands on its own connection and commits
  // immediately. Do not add a `tx` parameter.
  // ============================================

  /**
   * Minutes left on an active lockout, or `null` when the account is not
   * locked. The single reading of `lockedUntil`; no caller compares the
   * timestamp itself.
   */
  static lockoutMinutesRemaining(user: {
    lockedUntil: Date | null
  }): number | null {
    if (!user.lockedUntil || user.lockedUntil <= new Date()) return null
    return Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000)
  }

  /**
   * Refuse to go on while the account is locked out.
   *
   * `login()` deliberately does not call this. Its refusal predates
   * `AccountLockedError` and tells the signing-in user how many minutes are
   * left, which is what the sign-in form displays; changing that class would
   * be a behavior change to the login endpoint rather than the extraction it
   * looks like. Every other password prompt gets this generic refusal.
   */
  static assertNotLocked(user: { lockedUntil: Date | null }): void {
    if (this.lockoutMinutesRemaining(user) !== null) {
      throw new AccountLockedError()
    }
  }

  /**
   * Record one failed password check and lock the account when the budget is
   * spent. Returns the new count and whether this attempt was the one that
   * locked it.
   *
   * `currentFailedAttempts` is passed in rather than re-read because every
   * caller has already selected the row it is about to verify against.
   */
  static async recordFailedPasswordAttempt(
    userId: string,
    currentFailedAttempts: number,
    options: {
      source: PasswordAttemptSource
      ipAddress?: string | null
      username?: string
    },
  ): Promise<{ failedAttempts: number; locked: boolean }> {
    const failedAttempts = currentFailedAttempts + 1
    const locked = failedAttempts >= AuthService.MAX_FAILED_ATTEMPTS

    const updateFields: { failedLoginAttempts: number; lockedUntil?: Date } = {
      failedLoginAttempts: failedAttempts,
    }
    if (locked) {
      updateFields.lockedUntil = new Date(
        Date.now() + AuthService.LOCKOUT_DURATION_MINUTES * 60 * 1000,
      )
    }

    await db.update(users).set(updateFields).where(eq(users.id, userId))

    await db.insert(authEvents).values({
      userId,
      eventType: locked ? 'account_locked' : 'login_failed',
      ipAddress: options.ipAddress ?? null,
      metadata: {
        username: options.username,
        source: options.source,
        reason: locked ? 'max_attempts_exceeded' : 'invalid_password',
        failedAttempts,
      },
    })

    return { failedAttempts, locked }
  }

  /**
   * Clear the lockout state after a password check succeeded.
   *
   * `touchLastLogin` is what separates signing in from signing: both prove the
   * password, but only one of them is a login, and `users.lastLogin` is what
   * the admin screens report as last seen.
   */
  static async resetLockout(
    userId: string,
    options: { touchLastLogin?: boolean } = {},
  ): Promise<void> {
    await db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        ...(options.touchLastLogin ? { lastLogin: new Date() } : {}),
      })
      .where(eq(users.id, userId))
  }

  /**
   * Authenticate a user with username (email) and password.
   * Creates a session and returns the session token.
   *
   * Account lockout: After MAX_FAILED_ATTEMPTS consecutive failures,
   * the account is locked for LOCKOUT_DURATION_MINUTES. The counter
   * resets on successful login or after the lockout period expires.
   */
  static async login(input: LoginInput): Promise<LoginResult> {
    const {
      username,
      password,
      ipAddress = 'unknown',
      userAgent = 'unknown',
    } = input

    // Validate input
    if (!username || !password) {
      throw new ValidationError('Username and password are required')
    }

    // Find user by email (using email field for username)
    const result = await db
      .select()
      .from(users)
      .where(eq(users.email, username))
      .limit(1)

    const user = result.at(0)

    if (!user || !user.passwordHash) {
      // Log failed login attempt
      await db.insert(authEvents).values({
        eventType: 'login_failed',
        ipAddress,
        metadata: { username, reason: 'user_not_found' },
      })

      throw new AuthenticationError('Invalid username or password')
    }

    // Check if user is active
    if (!user.active) {
      await db.insert(authEvents).values({
        userId: user.id,
        eventType: 'login_failed',
        ipAddress,
        metadata: { username, reason: 'user_inactive' },
      })

      throw new AuthenticationError('Account is inactive')
    }

    // Check account lockout
    const minutesRemaining = this.lockoutMinutesRemaining(user)
    if (minutesRemaining !== null) {
      await db.insert(authEvents).values({
        userId: user.id,
        eventType: 'login_failed',
        ipAddress,
        metadata: { username, reason: 'account_locked', minutesRemaining },
      })

      throw new AuthenticationError(
        `Account is temporarily locked. Try again in ${minutesRemaining} minute${minutesRemaining === 1 ? '' : 's'}.`,
      )
    }

    // Verify password
    const isValidPassword = await verifyPassword(user.passwordHash, password)

    if (!isValidPassword) {
      // Increment failed attempts, lock on the last one, and audit either way.
      const { locked } = await this.recordFailedPasswordAttempt(
        user.id,
        user.failedLoginAttempts,
        { source: 'login', ipAddress, username },
      )

      if (locked) {
        throw new AuthenticationError(
          `Account locked due to too many failed attempts. Try again in ${AuthService.LOCKOUT_DURATION_MINUTES} minutes.`,
        )
      }

      throw new AuthenticationError('Invalid username or password')
    }

    // Successful login — reset lockout state
    await this.resetLockout(user.id, { touchLastLogin: true })

    // Rehash with Argon2id if still using legacy PBKDF2
    if (needsRehash(user.passwordHash)) {
      const newHash = await hashPassword(password)
      await db
        .update(users)
        .set({ passwordHash: newHash })
        .where(eq(users.id, user.id))
    }

    // Allow concurrent sessions per user (e.g. browser + Solid Edge plugin signed in at the
    // same time). We intentionally do NOT invalidate existing sessions on login; this matches
    // the OAuth login path, which has never rotated sessions. Sessions still expire normally
    // and can be revoked individually (logout) or in bulk if needed.
    const { sessionToken } = await SessionManager.createSession(
      user.id,
      ipAddress,
      userAgent,
    )

    // Log successful login
    await db.insert(authEvents).values({
      userId: user.id,
      eventType: 'login_success',
      ipAddress,
      metadata: { username },
    })

    return {
      success: true,
      sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    }
  }

  /**
   * Authenticate a user via OAuth provider.
   * Finds existing user by provider+providerId, or by email.
   * Creates a new user if none exists.
   */
  static async loginWithOAuth(input: {
    provider: 'github' | 'google' | 'azure'
    providerId: string
    email: string
    name: string | null
    ipAddress?: string
    userAgent?: string
  }): Promise<LoginResult> {
    const {
      provider,
      providerId,
      email,
      name,
      ipAddress = 'unknown',
      userAgent = 'unknown',
    } = input

    // First, try to find user by provider + providerId
    let user = (
      await db
        .select()
        .from(users)
        .where(eq(users.providerId, providerId))
        .limit(1)
    ).find((u) => u.provider === provider)

    // If not found by provider, try by email (link accounts)
    if (!user) {
      const existingByEmail = await db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .limit(1)

      const matchedByEmail = existingByEmail[0]
      if (matchedByEmail) {
        user = matchedByEmail
        // Link OAuth provider to existing account
        await db
          .update(users)
          .set({ provider, providerId })
          .where(eq(users.id, matchedByEmail.id))
      }
    }

    // If still no user, create one
    if (!user) {
      // Generate a random password (OAuth users won't use password auth)
      const randomPassword = crypto.randomUUID() + crypto.randomUUID()
      const passwordHash = await hashPassword(randomPassword)

      const newUser = takeFirst(
        await db
          .insert(users)
          .values({
            email,
            name: name || email.split('@')[0],
            passwordHash,
            provider,
            providerId,
            active: true,
          })
          .returning(),
      )

      user = newUser

      // Assign default "User" role
      const { roles, userRoles } = await import('@/lib/db/schema')
      const defaultRole = await db.query.roles.findFirst({
        where: eq(roles.name, 'User'),
      })
      if (defaultRole) {
        // Idempotent under the composite PK: a repeat assignment is a
        // no-op, never a 500.
        await db
          .insert(userRoles)
          .values({
            userId: user.id,
            roleId: defaultRole.id,
          })
          .onConflictDoNothing()
      }
    }

    // Check if user is active
    if (!user.active) {
      throw new AuthenticationError('Account is inactive')
    }

    // Update last login
    await db
      .update(users)
      .set({ lastLogin: new Date() })
      .where(eq(users.id, user.id))

    // Create session
    const { sessionToken } = await SessionManager.createSession(
      user.id,
      ipAddress,
      userAgent,
    )

    // Log successful OAuth login
    await db.insert(authEvents).values({
      userId: user.id,
      eventType: 'login_success',
      ipAddress,
      metadata: { email, provider, method: 'oauth' },
    })

    return {
      success: true,
      sessionToken,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
      },
    }
  }

  /**
   * Log out a user by invalidating their session.
   */
  static async logout(input: LogoutInput): Promise<LogoutResult> {
    const { sessionToken, ipAddress = 'unknown' } = input

    if (!sessionToken) {
      throw new AuthenticationError('No session found')
    }

    // Validate session to get user ID for logging
    const sessionData = await SessionManager.validateSession(sessionToken)

    // Delete session
    const sessionId = await hashSessionToken(sessionToken)
    await SessionManager.deleteSession(sessionId)

    // Log logout event
    if (sessionData) {
      await db.insert(authEvents).values({
        userId: sessionData.user.id,
        eventType: 'logout',
        ipAddress,
        metadata: { email: sessionData.user.email },
      })
    }

    return { success: true }
  }

  /**
   * Parse session token from cookie header string.
   */
  static parseSessionFromCookie(cookieHeader: string | null): string | null {
    if (!cookieHeader) return null

    const cookies = Object.fromEntries(
      cookieHeader.split('; ').map((c) => {
        const [key, ...v] = c.split('=')
        return [key, v.join('=')]
      }),
    )

    return cookies['session'] || null
  }
}
