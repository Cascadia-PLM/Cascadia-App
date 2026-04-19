// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { and, eq, gt, lt, ne } from 'drizzle-orm'
import { db } from '../db'
import { sessions, users } from '../db/schema'
import { generateSessionToken, hashSessionToken } from './password'
import { authLogger } from '@/lib/logging/logger'

export interface Session {
  id: string
  userId: string
  expiresAt: Date
  ipAddress?: string
  userAgent?: string
}

export interface SessionUser {
  id: string
  email: string
  name?: string | null
  active: boolean
}

export interface SessionValidationResult {
  session: Session
  user: SessionUser
}

/**
 * Session manager for handling user sessions
 */
export class SessionManager {
  private static readonly SESSION_DURATION = 8 * 60 * 60 * 1000 // 8 hours
  private static readonly EXTEND_THRESHOLD = 4 * 60 * 60 * 1000 // Extend when < 4 hours left

  /**
   * Create a new session for a user
   */
  static async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<{ sessionToken: string; session: Session }> {
    // Generate session token
    const sessionToken = generateSessionToken()
    const sessionId = await hashSessionToken(sessionToken)

    const expiresAt = new Date(Date.now() + this.SESSION_DURATION)

    // Store session in database
    const [session] = await db
      .insert(sessions)
      .values({
        id: sessionId,
        userId,
        expiresAt,
        ipAddress,
        userAgent,
      })
      .returning()

    return {
      sessionToken,
      session: {
        id: session.id,
        userId: session.userId,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress || undefined,
        userAgent: session.userAgent || undefined,
      },
    }
  }

  /**
   * Validate a session token and return session + user
   */
  static async validateSession(
    sessionToken: string,
  ): Promise<SessionValidationResult | null> {
    try {
      const sessionId = await hashSessionToken(sessionToken)

      // Query session with user data
      const result = await db
        .select({
          session: sessions,
          user: {
            id: users.id,
            email: users.email,
            name: users.name,
            active: users.active,
          },
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .where(
          and(eq(sessions.id, sessionId), gt(sessions.expiresAt, new Date())),
        )
        .limit(1)

      if (result.length === 0) {
        return null
      }

      const { session, user } = result[0]

      // Check if user is active
      if (!user.active) {
        await this.deleteSession(sessionId)
        return null
      }

      // Extend session if needed
      const timeLeft = session.expiresAt.getTime() - Date.now()
      if (timeLeft < this.EXTEND_THRESHOLD) {
        await this.extendSession(sessionId)
      }

      return {
        session: {
          id: session.id,
          userId: session.userId,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress || undefined,
          userAgent: session.userAgent || undefined,
        },
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          active: user.active,
        },
      }
    } catch (error) {
      authLogger.error({ err: error }, 'Session validation error')
      return null
    }
  }

  /**
   * Extend a session's expiration time
   */
  static async extendSession(sessionId: string): Promise<void> {
    const newExpiresAt = new Date(Date.now() + this.SESSION_DURATION)

    await db
      .update(sessions)
      .set({ expiresAt: newExpiresAt })
      .where(eq(sessions.id, sessionId))
  }

  /**
   * Delete a specific session
   */
  static async deleteSession(sessionId: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.id, sessionId))
  }

  /**
   * Delete all sessions for a user
   */
  static async deleteUserSessions(userId: string): Promise<void> {
    await db.delete(sessions).where(eq(sessions.userId, userId))
  }

  /**
   * Delete all sessions for a user except the specified one
   */
  static async deleteOtherSessions(
    userId: string,
    keepSessionId: string,
  ): Promise<void> {
    await db
      .delete(sessions)
      .where(and(eq(sessions.userId, userId), ne(sessions.id, keepSessionId)))
  }

  /**
   * Clean up expired sessions (should be run periodically)
   */
  static async cleanupExpiredSessions(): Promise<number> {
    const result = await db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .returning()

    return result.length
  }
}
