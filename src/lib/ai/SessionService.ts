/**
 * SessionService - Conversation Persistence for AI Chat
 *
 * This service manages AI chat sessions and message history:
 * - Creating and retrieving chat sessions
 * - Storing and loading message history
 * - Auto-generating session titles from first message
 * - Managing session metadata (program/design context)
 */

import { and, desc, eq } from 'drizzle-orm'

import type { ToolCall } from '@/lib/db/schema/ai'
import { aiChatMessages, aiChatSessions } from '@/lib/db/schema/ai'
import { db } from '@/lib/db'
import { programs } from '@/lib/db/schema/programs'
import { designs } from '@/lib/db/schema/designs'

// Message role types
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool'

// Message input for adding to history
export interface MessageInput {
  role: MessageRole
  content: string
  toolCalls?: Array<ToolCall>
  toolCallId?: string
  toolName?: string
}

// Message from database
export interface ChatMessage {
  id: string
  sessionId: string
  role: MessageRole
  content: string
  toolCalls: Array<ToolCall> | null
  toolCallId: string | null
  toolName: string | null
  createdAt: Date
}

// Session with related data
export interface ChatSession {
  id: string
  userId: string
  programId: string | null
  designId: string | null
  title: string | null
  createdAt: Date
  updatedAt: Date
  program?: {
    id: string
    name: string
    code: string
  } | null
  design?: {
    id: string
    name: string
    code: string
  } | null
}

// Session list item (for sidebar)
export interface SessionListItem {
  id: string
  title: string | null
  createdAt: Date
  updatedAt: Date
  messageCount?: number
}

/**
 * SessionService manages AI chat sessions and messages
 */
export class SessionService {
  /**
   * Create a new chat session
   */
  async createSession(
    userId: string,
    programId?: string,
    designId?: string,
  ): Promise<ChatSession> {
    const [session] = await db
      .insert(aiChatSessions)
      .values({
        userId,
        programId: programId || null,
        designId: designId || null,
      })
      .returning()

    return {
      id: session.id,
      userId: session.userId,
      programId: session.programId,
      designId: session.designId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }
  }

  /**
   * Get a session by ID with related program/design data
   */
  async getSession(sessionId: string): Promise<ChatSession | null> {
    const session = await db.query.aiChatSessions.findFirst({
      where: eq(aiChatSessions.id, sessionId),
      with: {
        program: true,
        design: true,
      },
    })

    if (!session) return null

    return {
      id: session.id,
      userId: session.userId,
      programId: session.programId,
      designId: session.designId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      program: session.program
        ? {
            id: session.program.id,
            name: session.program.name,
            code: session.program.code,
          }
        : null,
      design: session.design
        ? {
            id: session.design.id,
            name: session.design.name,
            code: session.design.code,
          }
        : null,
    }
  }

  /**
   * Get all sessions for a user
   */
  async getUserSessions(userId: string): Promise<Array<SessionListItem>> {
    const sessions = await db.query.aiChatSessions.findMany({
      where: eq(aiChatSessions.userId, userId),
      orderBy: desc(aiChatSessions.updatedAt),
    })

    return sessions.map((s) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
  }

  /**
   * Get message history for a session
   */
  async getMessageHistory(sessionId: string): Promise<Array<ChatMessage>> {
    const messages = await db.query.aiChatMessages.findMany({
      where: eq(aiChatMessages.sessionId, sessionId),
      orderBy: aiChatMessages.createdAt,
    })

    return messages.map((m) => ({
      id: m.id,
      sessionId: m.sessionId,
      role: m.role as MessageRole,
      content: m.content,
      toolCalls: m.toolCalls,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      createdAt: m.createdAt,
    }))
  }

  /**
   * Add a message to a session
   */
  async addMessage(
    sessionId: string,
    message: MessageInput,
  ): Promise<ChatMessage> {
    const [newMessage] = await db
      .insert(aiChatMessages)
      .values({
        sessionId,
        role: message.role,
        content: message.content,
        toolCalls: message.toolCalls || null,
        toolCallId: message.toolCallId || null,
        toolName: message.toolName || null,
      })
      .returning()

    // Update session's updatedAt timestamp
    await db
      .update(aiChatSessions)
      .set({ updatedAt: new Date() })
      .where(eq(aiChatSessions.id, sessionId))

    // Auto-generate title from first user message if not set
    if (message.role === 'user') {
      const session = await db.query.aiChatSessions.findFirst({
        where: eq(aiChatSessions.id, sessionId),
      })

      if (session && !session.title) {
        const title = this.generateTitle(message.content)
        await this.updateSessionTitle(sessionId, title)
      }
    }

    return {
      id: newMessage.id,
      sessionId: newMessage.sessionId,
      role: newMessage.role as MessageRole,
      content: newMessage.content,
      toolCalls: newMessage.toolCalls,
      toolCallId: newMessage.toolCallId,
      toolName: newMessage.toolName,
      createdAt: newMessage.createdAt,
    }
  }

  /**
   * Update session title
   */
  async updateSessionTitle(sessionId: string, title: string): Promise<void> {
    await db
      .update(aiChatSessions)
      .set({ title, updatedAt: new Date() })
      .where(eq(aiChatSessions.id, sessionId))
  }

  /**
   * Delete a session and all its messages
   */
  async deleteSession(sessionId: string): Promise<void> {
    // Messages are deleted via CASCADE
    await db.delete(aiChatSessions).where(eq(aiChatSessions.id, sessionId))
  }

  /**
   * Verify session belongs to user
   */
  async verifySessionOwnership(
    sessionId: string,
    userId: string,
  ): Promise<boolean> {
    const session = await db.query.aiChatSessions.findFirst({
      where: and(
        eq(aiChatSessions.id, sessionId),
        eq(aiChatSessions.userId, userId),
      ),
    })

    return !!session
  }

  /**
   * Generate a title from message content
   * Truncates to first sentence or 50 characters
   */
  private generateTitle(content: string): string {
    // Remove newlines and extra spaces
    const cleaned = content.replace(/\s+/g, ' ').trim()

    // Try to get first sentence
    const sentenceEnd = cleaned.search(/[.!?]/)
    if (sentenceEnd > 0 && sentenceEnd < 50) {
      return cleaned.substring(0, sentenceEnd + 1)
    }

    // Truncate to 50 characters
    if (cleaned.length <= 50) {
      return cleaned
    }

    // Find last word boundary before 50 chars
    const truncated = cleaned.substring(0, 50)
    const lastSpace = truncated.lastIndexOf(' ')
    if (lastSpace > 30) {
      return truncated.substring(0, lastSpace) + '...'
    }

    return truncated + '...'
  }

  /**
   * Get recent sessions count for a user
   */
  async getSessionCount(userId: string): Promise<number> {
    const sessions = await db.query.aiChatSessions.findMany({
      where: eq(aiChatSessions.userId, userId),
      columns: { id: true },
    })

    return sessions.length
  }

  /**
   * Clear old sessions (utility for cleanup)
   * Keeps the most recent `keepCount` sessions
   */
  async cleanupOldSessions(
    userId: string,
    keepCount: number = 50,
  ): Promise<number> {
    const sessions = await db.query.aiChatSessions.findMany({
      where: eq(aiChatSessions.userId, userId),
      orderBy: desc(aiChatSessions.updatedAt),
      columns: { id: true },
    })

    if (sessions.length <= keepCount) {
      return 0
    }

    const sessionsToDelete = sessions.slice(keepCount)
    const idsToDelete = sessionsToDelete.map((s) => s.id)

    for (const id of idsToDelete) {
      await this.deleteSession(id)
    }

    return idsToDelete.length
  }
}

// Export singleton instance
export const sessionService = new SessionService()
