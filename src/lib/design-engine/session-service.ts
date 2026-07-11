// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Design Session Service
 *
 * CRUD operations for collaborative design sessions.
 * Pattern follows SessionService from src/lib/ai/SessionService.ts.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import type {
  BomNodeDraft,
  DesignArtifacts,
  DesignSessionStage,
  DesignSessionStatus,
  LlmHistoryEntry,
  UserMessage,
} from './types'
import { db } from '@/lib/db'
import { designSessions } from '@/lib/db/schema/design-engine'
import { NotFoundError } from '@/lib/errors'

export interface DesignSession {
  id: string
  userId: string
  aiChatSessionId: string | null
  programId: string
  designId: string | null
  title: string | null
  stage: string
  status: string
  description: string | null
  artifacts: DesignArtifacts | null
  llmHistory: Array<LlmHistoryEntry> | null
  pendingGuidance: Array<UserMessage>
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  materializedDesignId: string | null
  errorMessage: string | null
  forkedFromSessionId: string | null
}

interface CreateSessionInput {
  description: string
  programId: string
  designId?: string
  aiChatSessionId?: string
}

export class DesignSessionService {
  static async create(
    userId: string,
    input: CreateSessionInput,
  ): Promise<DesignSession> {
    const title =
      input.description.length > 80
        ? input.description.substring(0, 77) + '...'
        : input.description

    const [session] = await db
      .insert(designSessions)
      .values({
        userId,
        programId: input.programId,
        designId: input.designId ?? null,
        aiChatSessionId: input.aiChatSessionId ?? null,
        title,
        description: input.description,
        stage: 'idle',
        status: 'active',
        artifacts: {
          description: input.description,
          requirements: [],
          bom: null,
          clarifications: [],
          userMessages: [],
        },
        llmHistory: [],
      })
      .returning()

    return session as DesignSession
  }

  static async getById(id: string): Promise<DesignSession | null> {
    const result = await db
      .select()
      .from(designSessions)
      .where(eq(designSessions.id, id))
      .limit(1)

    return result[0] as DesignSession | null
  }

  static async updateArtifacts(
    id: string,
    artifacts: DesignArtifacts,
  ): Promise<void> {
    await db
      .update(designSessions)
      .set({
        artifacts,
        updatedAt: new Date(),
      })
      .where(eq(designSessions.id, id))
  }

  static async updateStage(
    id: string,
    stage: DesignSessionStage,
  ): Promise<void> {
    await db
      .update(designSessions)
      .set({
        stage,
        updatedAt: new Date(),
      })
      .where(eq(designSessions.id, id))
  }

  static async updateStatus(
    id: string,
    status: DesignSessionStatus,
    errorMessage?: string,
  ): Promise<void> {
    await db
      .update(designSessions)
      .set({
        status,
        errorMessage: errorMessage ?? null,
        updatedAt: new Date(),
        ...(status === 'completed' ? { completedAt: new Date() } : {}),
      })
      .where(eq(designSessions.id, id))
  }

  static async saveLlmHistory(
    id: string,
    history: Array<LlmHistoryEntry>,
  ): Promise<void> {
    await db
      .update(designSessions)
      .set({
        llmHistory: history,
        updatedAt: new Date(),
      })
      .where(eq(designSessions.id, id))
  }

  static async getUserSessions(userId: string): Promise<Array<DesignSession>> {
    const results = await db
      .select()
      .from(designSessions)
      .where(eq(designSessions.userId, userId))
      .orderBy(desc(designSessions.updatedAt))

    return results as Array<DesignSession>
  }

  static async getUserActiveSessionsForProgram(
    userId: string,
    programId: string,
  ): Promise<Array<DesignSession>> {
    const results = await db
      .select()
      .from(designSessions)
      .where(
        and(
          eq(designSessions.userId, userId),
          eq(designSessions.programId, programId),
          eq(designSessions.status, 'active'),
        ),
      )
      .orderBy(desc(designSessions.updatedAt))

    return results as Array<DesignSession>
  }

  static async getProgramSessions(
    programId: string,
  ): Promise<Array<DesignSession>> {
    const results = await db
      .select()
      .from(designSessions)
      .where(
        and(
          eq(designSessions.programId, programId),
          eq(designSessions.status, 'active'),
        ),
      )
      .orderBy(desc(designSessions.updatedAt))

    return results as Array<DesignSession>
  }

  /**
   * Append a steering message to the session's mailbox. Atomic JSONB
   * concatenation — concurrent enqueues never lose messages.
   */
  static async enqueueGuidance(id: string, message: UserMessage): Promise<void> {
    await db
      .update(designSessions)
      .set({
        pendingGuidance: sql`coalesce(${designSessions.pendingGuidance}, '[]'::jsonb) || ${JSON.stringify([message])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(designSessions.id, id))
  }

  /**
   * Atomically take and clear the pending guidance. SELECT ... FOR UPDATE
   * inside a transaction guarantees each message is delivered exactly once
   * even when drains race (e.g. a stage loop and a stage start).
   */
  static async drainGuidance(id: string): Promise<Array<UserMessage>> {
    return db.transaction(async (tx) => {
      const [row] = await tx
        .select({ pendingGuidance: designSessions.pendingGuidance })
        .from(designSessions)
        .where(eq(designSessions.id, id))
        .for('update')

      const pending = row?.pendingGuidance ?? []
      if (pending.length === 0) return []

      await tx
        .update(designSessions)
        .set({ pendingGuidance: [], updatedAt: new Date() })
        .where(eq(designSessions.id, id))

      return pending
    })
  }

  /**
   * Fork a session so an alternative can be explored without destroying the
   * original's single mutable artifacts document.
   *
   * Integrity resets on the copy:
   * - pendingClarification is always cleared (it belongs to the source's
   *   stream; the fork's owner can resume and the AI re-asks if needed).
   * - If the source materialized (or reached that stage), the fork strips
   *   materializationResult, cadGenerationState, and all per-node
   *   generation status, and caps the stage at bom_review —
   *   materializationResult maps tempIds to REAL PLM itemIds, and a fork
   *   keeping it would upload regenerated CAD onto the original's parts.
   */
  static async fork(
    sessionId: string,
    userId: string,
    options?: { title?: string; includeLlmHistory?: boolean },
  ): Promise<DesignSession> {
    const source = await this.getById(sessionId)
    if (!source) {
      throw new NotFoundError('DesignSession', sessionId)
    }

    const artifacts: DesignArtifacts = source.artifacts
      ? (JSON.parse(JSON.stringify(source.artifacts)) as DesignArtifacts)
      : {
          description: source.description ?? '',
          requirements: [],
          bom: null,
          clarifications: [],
          userMessages: [],
        }

    artifacts.pendingClarificationId = undefined
    artifacts.pendingClarification = undefined

    let stage = source.stage as DesignSessionStage
    const generationStages: Array<DesignSessionStage> = [
      'materialization',
      'cad_generation',
      'cad_review',
      'assembly_composition',
      'assembly_review',
      'complete',
    ]
    const materialized =
      artifacts.materializationResult !== undefined ||
      generationStages.includes(stage)
    if (materialized) {
      artifacts.materializationResult = undefined
      artifacts.cadGenerationState = undefined
      if (artifacts.bom) {
        const strip = (node: BomNodeDraft) => {
          node.cadGeneration = undefined
          node.assemblyComposition = undefined
          node.children.forEach(strip)
        }
        strip(artifacts.bom.rootAssembly)
      }
      stage = 'bom_review'
    }

    const forked = await db.transaction(async (tx) => {
      const [session] = await tx
        .insert(designSessions)
        .values({
          userId,
          programId: source.programId,
          designId: source.designId,
          aiChatSessionId: null,
          title: options?.title ?? `${source.title ?? 'Design Session'} (variant)`,
          description: source.description,
          stage,
          status: 'active',
          artifacts,
          llmHistory:
            (options?.includeLlmHistory ?? true) ? (source.llmHistory ?? []) : [],
          pendingGuidance: [],
          forkedFromSessionId: source.id,
        })
        .returning()
      return session as DesignSession
    })

    // Preserve diff bases and rollback targets in the fork
    const { DesignSnapshotService } = await import('./snapshot-service')
    await DesignSnapshotService.copyToSession(source.id, forked.id)

    return forked
  }

  static async setMaterializedDesign(
    id: string,
    materializedDesignId: string,
  ): Promise<void> {
    await db
      .update(designSessions)
      .set({
        materializedDesignId,
        stage: 'complete',
        status: 'completed',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(designSessions.id, id))
  }
}
