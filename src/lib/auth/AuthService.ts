// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

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
import { AuthenticationError, ValidationError } from '@/lib/errors'

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

/** Maximum consecutive failed login attempts before lockout */
const MAX_FAILED_ATTEMPTS = 10

/** Lockout duration in minutes */
const LOCKOUT_DURATION_MINUTES = 15

/**
 * Service for handling authentication operations.
 */
export class AuthService {
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
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesRemaining = Math.ceil(
        (user.lockedUntil.getTime() - Date.now()) / 60000,
      )

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
      const newFailedAttempts = user.failedLoginAttempts + 1
      const isNowLocked = newFailedAttempts >= MAX_FAILED_ATTEMPTS

      // Increment failed attempts and optionally lock
      const updateFields: Record<string, unknown> = {
        failedLoginAttempts: newFailedAttempts,
      }
      if (isNowLocked) {
        updateFields.lockedUntil = new Date(
          Date.now() + LOCKOUT_DURATION_MINUTES * 60 * 1000,
        )
      }

      await db.update(users).set(updateFields).where(eq(users.id, user.id))

      // Log failed login attempt
      await db.insert(authEvents).values({
        userId: user.id,
        eventType: isNowLocked ? 'account_locked' : 'login_failed',
        ipAddress,
        metadata: {
          username,
          reason: isNowLocked ? 'max_attempts_exceeded' : 'invalid_password',
          failedAttempts: newFailedAttempts,
        },
      })

      if (isNowLocked) {
        throw new AuthenticationError(
          `Account locked due to too many failed attempts. Try again in ${LOCKOUT_DURATION_MINUTES} minutes.`,
        )
      }

      throw new AuthenticationError('Invalid username or password')
    }

    // Successful login — reset lockout state
    await db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLogin: new Date(),
      })
      .where(eq(users.id, user.id))

    // Rehash with Argon2id if still using legacy PBKDF2
    if (needsRehash(user.passwordHash)) {
      const newHash = await hashPassword(password)
      await db
        .update(users)
        .set({ passwordHash: newHash })
        .where(eq(users.id, user.id))
    }

    // Session rotation: invalidate all existing sessions before creating new one
    await SessionManager.deleteUserSessions(user.id)

    // Create session
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

      if (existingByEmail.length > 0) {
        user = existingByEmail[0]
        // Link OAuth provider to existing account
        await db
          .update(users)
          .set({ provider, providerId })
          .where(eq(users.id, user.id))
      }
    }

    // If still no user, create one
    if (!user) {
      // Generate a random password (OAuth users won't use password auth)
      const randomPassword = crypto.randomUUID() + crypto.randomUUID()
      const passwordHash = await hashPassword(randomPassword)

      const [newUser] = await db
        .insert(users)
        .values({
          email,
          name: name || email.split('@')[0],
          passwordHash,
          provider,
          providerId,
          active: true,
        })
        .returning()

      user = newUser

      // Assign default "User" role
      const { roles, userRoles } = await import('@/lib/db/schema')
      const defaultRole = await db.query.roles.findFirst({
        where: eq(roles.name, 'User'),
      })
      if (defaultRole) {
        await db.insert(userRoles).values({
          userId: user.id,
          roleId: defaultRole.id,
        })
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
