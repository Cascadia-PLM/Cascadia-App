// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Design Session Service
 *
 * CRUD operations for collaborative design sessions.
 * Pattern follows SessionService from cascadia-api/src/ai/SessionService.ts.
 */

import { and, desc, eq, sql } from 'drizzle-orm'
import type {
  BomNodeDraft,
  DesignArtifacts,
  DesignSessionStage,
  DesignSessionStatus,
  LlmHistoryEntry,
  MaterializationJournal,
  UserMessage,
} from './types'
import { db } from '@/db'
import { designSessions } from '@/db/schema/design-engine'
import { ConflictError, NotFoundError } from '@/errors'
import { serviceLogger } from '@/logging/logger'

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
  /** Compare-and-set token for artifacts writes; see updateArtifacts. */
  artifactsVersion: number
  llmHistory: Array<LlmHistoryEntry> | null
  pendingGuidance: Array<UserMessage>
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  materializedDesignId: string | null
  /** Step journal of the running/failed materialization; null when clean. */
  materializationJournal: MaterializationJournal | null
  errorMessage: string | null
  forkedFromSessionId: string | null
}

/**
 * A design session as the LIST endpoints return it.
 *
 * The lists used to `select()` every column, which shipped each session's
 * whole artifacts document and its entire LLM transcript to a sidebar that
 * renders neither — a page of sessions could run to megabytes of JSON to
 * paint a dozen table rows. The detail read (`getById`) is unchanged: the
 * workspace genuinely needs the full document.
 *
 * Kept as its own type rather than as optional fields on `DesignSession`, so
 * a caller cannot quietly read a column the list query no longer fetches.
 */
export interface DesignSessionSummary {
  id: string
  userId: string
  programId: string
  designId: string | null
  title: string | null
  stage: string
  status: string
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
  materializedDesignId: string | null
  forkedFromSessionId: string | null
}

/** The columns behind `DesignSessionSummary`, shared by both list queries. */
const SUMMARY_COLUMNS = {
  id: designSessions.id,
  userId: designSessions.userId,
  programId: designSessions.programId,
  designId: designSessions.designId,
  title: designSessions.title,
  stage: designSessions.stage,
  status: designSessions.status,
  createdAt: designSessions.createdAt,
  updatedAt: designSessions.updatedAt,
  completedAt: designSessions.completedAt,
  materializedDesignId: designSessions.materializedDesignId,
  forkedFromSessionId: designSessions.forkedFromSessionId,
}

interface CreateSessionInput {
  description: string
  programId: string
  designId?: string
  aiChatSessionId?: string
}

/**
 * How stale a stream claim must be before another stream may take the slot
 * over — 3x the heartbeat cadence below, so only a stream that stopped
 * heartbeating (crashed server, killed process) loses its claim.
 */
const STREAM_CLAIM_STALE_MS = 90_000

/**
 * How often a running stream refreshes its claim's liveness. Kept next to the
 * staleness window it is measured against: the two are one invariant, and a
 * cadence that drifts up to meet the window is how a healthy stream starts
 * losing its slot.
 */
const STREAM_HEARTBEAT_MS = 30_000

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

  /**
   * Write the artifacts document, bumping its version counter.
   *
   * With `expectedVersion`, the write is a compare-and-set: it applies only
   * if no other artifacts write landed since the caller read the session,
   * and throws ConflictError otherwise — the caller re-reads and retries or
   * surfaces the 409. Read-modify-write callers (engine edits, the PATCH
   * route, the stream route's clarification/message merges) pass the version
   * they read.
   *
   * Without it, the write is last-writer-wins — deliberately kept for the
   * stage generators: DE-1's stream claim already makes the running stream
   * the session's only streaming writer, and forcing CAS retry loops into
   * generators that own the document while they run would buy nothing.
   */
  static async updateArtifacts(
    id: string,
    artifacts: DesignArtifacts,
    expectedVersion?: number,
  ): Promise<void> {
    const updated = await db
      .update(designSessions)
      .set({
        artifacts,
        artifactsVersion: sql`${designSessions.artifactsVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(
        expectedVersion === undefined
          ? eq(designSessions.id, id)
          : and(
              eq(designSessions.id, id),
              eq(designSessions.artifactsVersion, expectedVersion),
            ),
      )
      .returning({ id: designSessions.id })

    // An update with a WHERE can legitimately match nothing — guard and
    // throw, never takeFirst (the CLAUDE.md rule).
    if (updated.length === 0) {
      if (expectedVersion !== undefined) {
        const exists = await this.getById(id)
        if (exists) {
          throw new ConflictError(
            'The session artifacts changed since they were read; re-read and retry',
          )
        }
      }
      throw new NotFoundError('DesignSession', id)
    }
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

  static async getUserSessions(
    userId: string,
  ): Promise<Array<DesignSessionSummary>> {
    const results = await db
      .select(SUMMARY_COLUMNS)
      .from(designSessions)
      .where(eq(designSessions.userId, userId))
      .orderBy(desc(designSessions.updatedAt))

    return results
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

    return results
  }

  static async getProgramSessions(
    programId: string,
  ): Promise<Array<DesignSessionSummary>> {
    const results = await db
      .select(SUMMARY_COLUMNS)
      .from(designSessions)
      .where(
        and(
          eq(designSessions.programId, programId),
          eq(designSessions.status, 'active'),
        ),
      )
      .orderBy(desc(designSessions.updatedAt))

    return results
  }

  /**
   * Claim the session's one streaming slot, returning the claim id.
   *
   * A design session admits exactly one streaming writer at a time — the
   * stage generators persist artifacts as they go, and two generators
   * interleaving over the same session write each other's state back out.
   * Nothing UI-side stops a second tab opening a second stream, so the
   * server refuses it here with a 409.
   *
   * The advisory xact lock serializes the claim *decision* only (precedent:
   * SignatureService.collect) — it cannot span the long-lived SSE stream, so
   * ownership lives in `activeStreamId` and liveness in `streamClaimedAt`,
   * which the running stream heartbeats on a timer (startStreamHeartbeat).
   * A claim older than the staleness window is taken over: that is what
   * un-strands a session whose server crashed mid-stream, at the cost of a
   * window where a wedged-but-alive stream can be displaced. Because the beat
   * is a timer and not a function of event traffic, only a stream whose
   * process is gone stops beating — a stage that produces no events for ten
   * minutes keeps its slot.
   */
  static async claimStream(id: string): Promise<string> {
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${id}))`)

      const [row] = await tx
        .select({
          activeStreamId: designSessions.activeStreamId,
          streamClaimedAt: designSessions.streamClaimedAt,
        })
        .from(designSessions)
        .where(eq(designSessions.id, id))

      if (!row) {
        throw new NotFoundError('DesignSession', id)
      }

      const claimAge = row.streamClaimedAt
        ? Date.now() - row.streamClaimedAt.getTime()
        : Number.POSITIVE_INFINITY
      if (row.activeStreamId && claimAge < STREAM_CLAIM_STALE_MS) {
        throw new ConflictError(
          'Another stream is already active for this design session',
        )
      }

      const claimId = crypto.randomUUID()
      await tx
        .update(designSessions)
        .set({
          activeStreamId: claimId,
          streamClaimedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(designSessions.id, id))

      return claimId
    })
  }

  /**
   * Refresh the claim's liveness. Guarded on the claim id, so a takeover's
   * new owner is never touched by the displaced stream's late heartbeat.
   */
  static async heartbeatStream(id: string, claimId: string): Promise<void> {
    await db
      .update(designSessions)
      .set({ streamClaimedAt: new Date() })
      .where(
        and(
          eq(designSessions.id, id),
          eq(designSessions.activeStreamId, claimId),
        ),
      )
  }

  /**
   * Beat the claim on a timer for as long as the stream is open, returning the
   * function that stops it.
   *
   * The beat cannot be driven by event traffic. A CAD stage sits ~10 minutes
   * inside one `zooClient.generateAndWait` per part and assembly composition
   * sits minutes inside `AssemblyPlanner.planAssembly`, neither yielding an
   * event; an event-driven beat lets a perfectly live run age past
   * STREAM_CLAIM_STALE_MS, and the next tab to open a stream takes the slot
   * over. Two generators then interleave over one artifacts blob and one CAD
   * budget — precisely what the claim exists to prevent. A timer beats through
   * the quiet stretches, so takeover means what its documentation says: the
   * process holding the claim is gone.
   *
   * Each beat is claim-id-guarded by `heartbeatStream`, so a stream that was
   * displaced before its caller noticed keeps beating harmlessly: it revives
   * neither its own claim nor the new owner's liveness. Beats never overlap,
   * and a failed one is logged and swallowed — a rejection inside a timer
   * callback has nowhere to go but an unhandled rejection, and one transient
   * database error must not take the process down mid-generation.
   */
  static startStreamHeartbeat(
    id: string,
    claimId: string,
    intervalMs: number = STREAM_HEARTBEAT_MS,
  ): () => void {
    let beating = false
    const timer = setInterval(() => {
      if (beating) return
      beating = true
      void DesignSessionService.heartbeatStream(id, claimId)
        .catch((error: unknown) => {
          serviceLogger.warn(
            { sessionId: id, claimId, err: error },
            'Design session stream heartbeat failed; the claim goes stale and may be taken over if this persists',
          )
        })
        .finally(() => {
          beating = false
        })
    }, intervalMs)
    // Never a reason to hold the process open: the stream's `finally` stops it.
    timer.unref()

    return () => {
      clearInterval(timer)
    }
  }

  /**
   * Release the streaming slot — only the claim that holds it. A stream that
   * was taken over releases nothing; the new owner's claim survives.
   */
  static async releaseStream(id: string, claimId: string): Promise<void> {
    await db
      .update(designSessions)
      .set({ activeStreamId: null, streamClaimedAt: null })
      .where(
        and(
          eq(designSessions.id, id),
          eq(designSessions.activeStreamId, claimId),
        ),
      )
  }

  /**
   * Append a steering message to the session's mailbox. Atomic JSONB
   * concatenation — concurrent enqueues never lose messages.
   */
  static async enqueueGuidance(
    id: string,
    message: UserMessage,
  ): Promise<void> {
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
          title:
            options?.title ?? `${source.title ?? 'Design Session'} (variant)`,
          description: source.description,
          stage,
          status: 'active',
          artifacts,
          llmHistory:
            (options?.includeLlmHistory ?? true)
              ? (source.llmHistory ?? [])
              : [],
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
        // Success clears the journal: nothing left to resume.
        materializationJournal: null,
        updatedAt: new Date(),
      })
      .where(eq(designSessions.id, id))
  }

  /**
   * How stale a 'running' materialization journal must be before another
   * run may take it over — generous, because materialization is dozens of
   * sequential item creations, not a streaming heartbeat.
   */
  static readonly MATERIALIZATION_CLAIM_STALE_MS = 10 * 60_000

  /**
   * Claim the session's materialization slot by compare-and-set.
   *
   * Returns the journal this run owns — carrying every step a previous
   * failed (or crashed-stale) run completed, so execute() resumes instead
   * of duplicating. A fresh 'running' journal means another request is
   * mid-flight: 409, closing the double-POST hole the route's status check
   * leaves open. The CAS predicate is the previous journal's exact
   * `startedAt` (or its absence), so two concurrent claims cannot both win.
   *
   * `resumed` says whether a journal was already there — that is, whether
   * some earlier run touched this session's materialization. The journal
   * records only the steps that *completed*, so a step that landed in the
   * database and never reached the journal is invisible in it; `resumed` is
   * what tells execute() to go looking for such an orphan before creating
   * anything, and to skip those lookups entirely on a first run.
   */
  static async claimMaterialization(
    id: string,
  ): Promise<{ journal: MaterializationJournal; resumed: boolean }> {
    const rows = await db
      .select({ journal: designSessions.materializationJournal })
      .from(designSessions)
      .where(eq(designSessions.id, id))
      .limit(1)
    const row = rows.at(0)
    if (!row) throw new NotFoundError('DesignSession', id)

    const prev = row.journal
    if (
      prev?.status === 'running' &&
      Date.now() - Date.parse(prev.startedAt) <
        this.MATERIALIZATION_CLAIM_STALE_MS
    ) {
      throw new ConflictError(
        'A materialization is already running for this session',
        { sessionId: id, startedAt: prev.startedAt },
      )
    }

    const next: MaterializationJournal = {
      items: {},
      relationships: [],
      ...(prev ?? {}),
      status: 'running',
      startedAt: new Date().toISOString(),
    }

    const claimed = await db
      .update(designSessions)
      .set({ materializationJournal: next, updatedAt: new Date() })
      .where(
        and(
          eq(designSessions.id, id),
          prev
            ? sql`${designSessions.materializationJournal}->>'startedAt' = ${prev.startedAt}`
            : sql`${designSessions.materializationJournal} IS NULL`,
        ),
      )
      .returning({ id: designSessions.id })

    if (claimed.length === 0) {
      throw new ConflictError(
        'A materialization is already running for this session',
        { sessionId: id },
      )
    }
    return { journal: next, resumed: prev != null }
  }

  /** Persist the running journal after a completed step. */
  static async saveMaterializationJournal(
    id: string,
    journal: MaterializationJournal,
  ): Promise<void> {
    await db
      .update(designSessions)
      .set({ materializationJournal: journal, updatedAt: new Date() })
      .where(eq(designSessions.id, id))
  }
}
