// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import type {
  DesignArtifacts,
  DesignSessionStage,
  StageEvent,
} from '@/design-engine/types'
import { tagged } from '@/server/adapter'
import { apiHandler, created } from '@/api/handler'
import { DesignSessionService } from '@/design-engine/session-service'
import { DesignSnapshotService } from '@/design-engine/snapshot-service'
import { MaterializationService } from '@/design-engine/materialize'
import { designEngine } from '@/design-engine/engine'
import { AccessControlService } from '@/auth/AccessControlService'
import { NotFoundError, PermissionDeniedError, ValidationError } from '@/errors'
import { requireSessionAccess } from '@/auth/session-access'
import { acquireStreamSlot, releaseStreamSlot } from '@/ai/stream-limits'
import { applyArtifactsPatch } from '@/design-engine/artifacts-patch'
import {
  designArtifactsPatchSchema,
  designSessionStageSchema,
  stageIndex,
} from '@/design-engine/types'

const adapt = tagged('Design Engine')

const createSessionSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  programId: z.string().uuid('Invalid program ID'),
  designId: z.string().uuid('Invalid design ID').optional(),
  aiChatSessionId: z.string().uuid('Invalid chat session ID').optional(),
})

const forkSessionSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  includeLlmHistory: z.boolean().optional(),
})

const streamActionSchema = z.object({
  action: z.enum([
    'start_toolset',
    'start_requirements',
    'start_bom',
    'start_cad_generation',
    'start_assembly_composition',
    'regenerate_part',
    'resume',
    'confirm_toolset',
    'confirm_requirements',
    'confirm_bom',
    'confirm_cad',
    'confirm_assembly',
    'answer_clarification',
    'send_message',
    'revise',
    'reopen_stage',
  ]),
  questionId: z.string().optional(),
  answer: z.string().optional(),
  message: z.string().optional(),
  tempId: z.string().optional(),
  feedback: z.string().optional(),
  targetStage: z
    .enum(['toolset_review', 'requirements_review', 'bom_review'])
    .optional(),
  // Skip the per-item review gate on confirm_* ("Confirm anyway")
  force: z.boolean().optional(),
  // send_message only: enqueue into the mid-stream steering mailbox instead
  // of restarting the drafting stream (client sets this while it holds an
  // open stream; the running stage loop drains the mailbox mid-generation)
  queue: z.boolean().optional(),
})

function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

/**
 * Map a stage that supports a streaming (re)start to the generator that runs it.
 *
 * Covers the drafting stages that can pause for a clarification / user guidance
 * and later resume: toolset establishment, requirements, and BOM. Returns null
 * for stages with no streaming resume path (reviews, materialization, etc.).
 *
 * Each generator re-fetches the session, so any answer/message persisted just
 * before the call is picked up as context when the stage continues.
 */
function draftingStageSource(
  stage: string,
  sessionId: string,
  signal: AbortSignal,
): AsyncIterable<StageEvent> | null {
  switch (stage) {
    case 'toolset_establishment':
      return designEngine.runToolsetEstablishmentStage(sessionId, signal)
    case 'requirements_drafting':
      return designEngine.runRequirementsStage(sessionId, signal)
    case 'bom_drafting':
      return designEngine.runBomStage(sessionId, signal)
    // Generation stages are resume-idempotent (completed parts/assemblies
    // are skipped), so clarification answers and resume re-enter them safely.
    case 'cad_generation':
      return designEngine.runCadGenerationStage(sessionId, signal)
    case 'assembly_composition':
      return designEngine.runAssemblyCompositionStage(sessionId, signal)
    default:
      return null
  }
}

/**
 * Which drafting stage a review gate re-enters when the user leaves feedback.
 * Only the LLM-driven gates map — CAD/assembly review regenerate through the
 * FreeCAD agent and the render worker,
 * which don't consume comments/guidance and are expensive to re-run blindly.
 */
const REVIEW_TO_DRAFTING: Record<string, string> = {
  toolset_review: 'toolset_establishment',
  requirements_review: 'requirements_drafting',
  bom_review: 'bom_drafting',
}

/**
 * Start (or re-enter) the drafting stage for a given session stage so a run
 * consumes freshly-persisted review feedback. From a review gate this first
 * drops the session back to the matching drafting stage, which makes the stage
 * resume in place (revise the existing artifact) rather than start fresh. From
 * a drafting stage it just returns that stage's generator. Returns null when the
 * stage has no drafting re-run (e.g. cad/assembly review, materialization).
 */
async function reRunFromReview(
  stage: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<AsyncIterable<StageEvent> | null> {
  const draftingStage = REVIEW_TO_DRAFTING[stage]
  if (draftingStage) {
    await DesignSessionService.updateStage(
      sessionId,
      draftingStage as DesignSessionStage,
    )
    return draftingStageSource(draftingStage, sessionId, signal)
  }
  return draftingStageSource(stage, sessionId, signal)
}

function findPendingQuestion(
  artifacts: DesignArtifacts,
  questionId: string,
): string {
  if (artifacts.pendingClarification?.id === questionId) {
    return artifacts.pendingClarification.question
  }
  return questionId
}

/**
 * Create an SSE streaming Response from a StageEvent async iterable.
 *
 * Claims the session's one streaming slot before the generator produces its
 * first event — a second tab's stream gets a 409 from the claim, as an HTTP
 * status rather than an SSE error, before any LLM work starts. The claim is
 * heartbeated on a timer for as long as this stream is open, and released
 * when the stream ends, however it ends.
 *
 * The beat is deliberately not tied to event traffic: a CAD or assembly stage
 * can run for minutes between events, and a claim that only refreshes when an
 * event arrives goes stale mid-generation and gets taken over. See
 * DesignSessionService.startStreamHeartbeat.
 *
 * Artifacts are NOT persisted here. Every stage generator persists its own
 * state as it goes; this route re-reading and re-writing the same artifacts
 * on every artifact_update event was a second, unsynchronized writer racing
 * the generator over one JSONB blob.
 *
 * The session claim bounds one SESSION to one stream; it says nothing about a
 * user, who can open as many sessions as they like. So a per-user slot in the
 * design pool is taken first (429 at the cap, before any database work), and
 * released exactly once however this ends — the claim failing, the generator
 * throwing, or the client disconnecting.
 */
async function streamResponse(
  eventSource: AsyncIterable<StageEvent>,
  sessionId: string,
  request: Request,
  userId: string,
): Promise<Response> {
  acquireStreamSlot(userId, 'design')
  let streamSlotReleased = false
  const releaseSlotOnce = () => {
    if (!streamSlotReleased) {
      streamSlotReleased = true
      releaseStreamSlot(userId, 'design')
    }
  }

  let claimId: string
  try {
    claimId = await DesignSessionService.claimStream(sessionId)
  } catch (error) {
    releaseSlotOnce()
    throw error
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      // Started and stopped in the same function body, so no exit path —
      // normal end, throw, or client abort — can leave the timer running.
      const stopHeartbeat = DesignSessionService.startStreamHeartbeat(
        sessionId,
        claimId,
      )
      try {
        for await (const event of eventSource) {
          if (request.signal.aborted) break

          const sseData = encodeSSE('stage_event', event)
          controller.enqueue(encoder.encode(sseData))

          // Update stage on stage_change events
          if (event.type === 'stage_change') {
            await DesignSessionService.updateStage(sessionId, event.stage)
          }

          // Handle errors
          if (event.type === 'error') {
            await DesignSessionService.updateStatus(
              sessionId,
              'failed',
              event.message,
            )
          }
        }

        // Send done event
        controller.enqueue(
          encoder.encode(encodeSSE('done', { finished: true })),
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error'
        controller.enqueue(
          encoder.encode(
            encodeSSE('stage_event', {
              type: 'error',
              message,
            }),
          ),
        )
        await DesignSessionService.updateStatus(sessionId, 'failed', message)
      } finally {
        stopHeartbeat()
        await DesignSessionService.releaseStream(sessionId, claimId)
        releaseSlotOnce()
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Session-Id': sessionId,
    },
  })
}

/**
 * The three things a session PATCH may set. `artifacts` stays loose here and
 * is parsed against `designArtifactsPatchSchema` in the handler — it is a
 * partial over the whole artifact tree, and running it twice would be the only
 * effect of naming it here.
 */
/**
 * What a session's artifacts are before any stage has run. Used when a PATCH
 * arrives on a session whose artifacts column is still null.
 */
const EMPTY_ARTIFACTS: DesignArtifacts = {
  description: '',
  requirements: [],
  bom: null,
  clarifications: [],
  userMessages: [],
}

const sessionPatchSchema = z.object({
  description: z.string().max(20000).optional(),
  artifacts: z.record(z.string(), z.unknown()).optional(),
  stage: designSessionStageSchema.optional(),
})

const app = new Hono()

// GET /api/design-engine/sessions
//
// Summary rows only (DesignSessionSummary) — the sessions table renders
// title/stage/status/dates and nothing else, so neither list carries the
// artifacts document or the LLM transcript. The full session is served by
// GET /sessions/:id below, which the workspace loads for exactly one session.
app.get(
  '/sessions',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url, 'http://localhost')
      const programId = url.searchParams.get('programId')

      if (programId) {
        // Team view: return all active sessions for the program
        const canAccess = await AccessControlService.canAccessProgram(
          user.id,
          programId,
        )
        if (!canAccess) {
          throw new PermissionDeniedError('program', 'access')
        }
        const sessions =
          await DesignSessionService.getProgramSessions(programId)
        return { sessions }
      }

      // Default: return user's own sessions
      const sessions = await DesignSessionService.getUserSessions(user.id)
      return { sessions }
    }),
  ),
)

// POST /api/design-engine/sessions
app.post(
  '/sessions',
  adapt(
    apiHandler({ body: createSessionSchema }, async ({ body, user }) => {
      // Validate program membership before creating session
      const canAccess = await AccessControlService.canAccessProgram(
        user.id,
        body.programId,
      )
      if (!canAccess) {
        throw new PermissionDeniedError('program', 'access')
      }

      const session = await DesignSessionService.create(user.id, body)

      return created({
        session: {
          id: session.id,
          title: session.title,
          stage: session.stage,
          status: session.status,
          workspaceUrl: `/designs/collaborative/${session.id}`,
        },
      })
    }),
  ),
)

// GET /api/design-engine/sessions/:id
app.get(
  '/sessions/:id',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      if (!params.id) throw new ValidationError('Session id is required')
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'read')

      return { session }
    }),
  ),
)

// PATCH /api/design-engine/sessions/:id
app.patch(
  '/sessions/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof sessionPatchSchema>>(
      { body: sessionPatchSchema },
      async ({ params, body, user }) => {
        if (!params.id) throw new ValidationError('Session id is required')
        const session = await DesignSessionService.getById(params.id)

        if (!session) {
          throw new NotFoundError('DesignSession', params.id)
        }

        await requireSessionAccess(user.id, session, 'write')

        // Update description
        if (typeof body.description === 'string') {
          const artifacts = session.artifacts ?? { ...EMPTY_ARTIFACTS }
          artifacts.description = body.description
          await DesignSessionService.updateArtifacts(
            params.id,
            artifacts,
            session.artifactsVersion,
          )
        }

        // Update artifacts directly (with validation)
        if (body.artifacts) {
          const parsed = designArtifactsPatchSchema.parse(body.artifacts)
          // The client edited what it read; a stream or another tab writing in
          // between makes this a 409 instead of a silent overwrite. The session
          // was fetched at the top of this handler; a description update above
          // bumps the version, so re-read before a combined write.
          const fresh =
            typeof body.description === 'string'
              ? await DesignSessionService.getById(params.id)
              : session
          // Overlay, not replace. The schema is a partial over every field, so
          // writing the parse result wholesale made the natural partial body
          // wipe whatever it did not mention — and it let a client supply
          // server-owned artifacts, `materializationResult` above all.
          await DesignSessionService.updateArtifacts(
            params.id,
            applyArtifactsPatch(fresh?.artifacts ?? EMPTY_ARTIFACTS, parsed),
            fresh?.artifactsVersion,
          )
        }

        // Update stage (with validation). Backward moves must go through the
        // reopen_stage action, which restores the matching artifacts snapshot —
        // a raw backward PATCH would leave artifacts from the abandoned pass.
        if (body.stage) {
          const result = designSessionStageSchema.safeParse(body.stage)
          if (!result.success) {
            throw new ValidationError('Invalid stage value')
          }
          if (
            stageIndex(result.data) <
            stageIndex(session.stage as DesignSessionStage)
          ) {
            throw new ValidationError(
              'Cannot move a session backward via PATCH — use the reopen_stage stream action',
            )
          }
          await DesignSessionService.updateStage(params.id, result.data)
        }

        const updated = await DesignSessionService.getById(params.id)
        return { session: updated }
      },
    ),
  ),
)

// POST /api/design-engine/sessions/:id/fork — copy the session to explore a variant
app.post(
  '/sessions/:id/fork',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof forkSessionSchema> | undefined>(
      { body: forkSessionSchema.optional() },
      async ({ params, body, user }) => {
        if (!params.id) throw new ValidationError('Session id is required')
        const session = await DesignSessionService.getById(params.id)

        if (!session) {
          throw new NotFoundError('DesignSession', params.id)
        }

        // Forking is non-destructive to the source, so read access suffices;
        // the fork itself is owned (and writable) by the forking user.
        await requireSessionAccess(user.id, session, 'read')

        const forked = await DesignSessionService.fork(params.id, user.id, {
          title: body?.title,
          includeLlmHistory: body?.includeLlmHistory,
        })

        return created({
          session: {
            id: forked.id,
            title: forked.title,
            stage: forked.stage,
            status: forked.status,
            forkedFromSessionId: forked.forkedFromSessionId,
            workspaceUrl: `/designs/collaborative/${forked.id}`,
          },
        })
      },
    ),
  ),
)

// GET /api/design-engine/sessions/:id/snapshots — metadata only, newest first
app.get(
  '/sessions/:id/snapshots',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      if (!params.id) throw new ValidationError('Session id is required')
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'read')

      const snapshots = await DesignSnapshotService.listBySession(params.id)
      return { snapshots }
    }),
  ),
)

// GET /api/design-engine/sessions/:id/snapshots/:snapshotId — full artifacts payload
app.get(
  '/sessions/:id/snapshots/:snapshotId',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      if (!params.id) throw new ValidationError('Session id is required')
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'read')

      if (!params.snapshotId)
        throw new ValidationError('Snapshot id is required')
      const snapshot = await DesignSnapshotService.getById(params.snapshotId)
      if (!snapshot || snapshot.sessionId !== params.id) {
        throw new NotFoundError('DesignSessionSnapshot', params.snapshotId)
      }

      return { snapshot }
    }),
  ),
)

// GET /api/design-engine/sessions/:id/materialize
app.get(
  '/sessions/:id/materialize',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      if (!params.id) throw new ValidationError('Session id is required')
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'read')

      if (!session.artifacts?.bom) {
        throw new ValidationError('No BOM to materialize')
      }

      const preview = await MaterializationService.preview(session)
      return { preview }
    }),
  ),
)

// POST /api/design-engine/sessions/:id/materialize
app.post(
  '/sessions/:id/materialize',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      if (!params.id) throw new ValidationError('Session id is required')
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'write')

      if (!session.artifacts?.bom) {
        throw new ValidationError('No BOM to materialize')
      }

      if (session.status === 'completed') {
        throw new ValidationError('This session has already been materialized')
      }

      const result = await MaterializationService.execute(session, user.id)
      return { result }
    }),
  ),
)

// POST /api/design-engine/sessions/:id/stream
app.post(
  '/sessions/:id/stream',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof streamActionSchema>>(
      { body: streamActionSchema },
      async ({ params, request, body, user }) => {
        if (!params.id) throw new ValidationError('Session id is required')
        const session = await DesignSessionService.getById(params.id)

        if (!session) {
          throw new NotFoundError('DesignSession', params.id)
        }

        await requireSessionAccess(user.id, session, 'write')

        const parsed = { data: body }
        const { action } = body

        // Create abort controller for cancelling LLM calls on client disconnect
        const abortController = new AbortController()
        request.signal.addEventListener('abort', () => {
          abortController.abort()
        })

        // Handle stage confirmations (non-streaming)
        if (action === 'confirm_toolset') {
          await designEngine.confirmStage(params.id, 'toolset')
          const updated = await DesignSessionService.getById(params.id)
          return { session: updated, confirmed: 'toolset' }
        }

        if (action === 'confirm_requirements') {
          await designEngine.confirmStage(params.id, 'requirements', {
            force: parsed.data.force,
          })
          const updated = await DesignSessionService.getById(params.id)
          return { session: updated, confirmed: 'requirements' }
        }

        if (action === 'confirm_bom') {
          await designEngine.confirmStage(params.id, 'bom', {
            force: parsed.data.force,
          })
          const updated = await DesignSessionService.getById(params.id)
          return { session: updated, confirmed: 'bom' }
        }

        if (action === 'confirm_cad') {
          await designEngine.confirmStage(params.id, 'cad')
          const updated = await DesignSessionService.getById(params.id)
          return { session: updated, confirmed: 'cad' }
        }

        if (action === 'confirm_assembly') {
          await designEngine.confirmStage(params.id, 'assembly')
          const updated = await DesignSessionService.getById(params.id)
          return { session: updated, confirmed: 'assembly' }
        }

        // Reopen a previously confirmed review gate (non-streaming)
        if (action === 'reopen_stage') {
          const { targetStage } = parsed.data
          if (!targetStage) {
            throw new ValidationError(
              'targetStage is required for reopen_stage',
            )
          }
          await designEngine.reopenStage(params.id, targetStage)
          const updated = await DesignSessionService.getById(params.id)
          return { session: updated, reopened: targetStage }
        }

        // Handle clarification answers — store structured entry and restart stage as streaming
        if (action === 'answer_clarification') {
          const { questionId, answer } = parsed.data
          if (!questionId || !answer) {
            throw new ValidationError(
              'questionId and answer are required for answer_clarification',
            )
          }

          const current = await DesignSessionService.getById(params.id)
          if (current?.artifacts) {
            const pending =
              current.artifacts.pendingClarification?.id === questionId
                ? current.artifacts.pendingClarification
                : undefined
            const artifacts: DesignArtifacts = {
              ...current.artifacts,
              clarifications: [
                ...current.artifacts.clarifications,
                {
                  questionId,
                  question:
                    pending?.question ??
                    findPendingQuestion(current.artifacts, questionId),
                  options: pending?.options,
                  multiSelect: pending?.multiSelect,
                  answer,
                  answeredAt: new Date().toISOString(),
                  stage: current.stage as DesignSessionStage,
                },
              ],
              userMessages: current.artifacts.userMessages,
              pendingClarificationId: undefined,
              pendingClarification: undefined,
            }
            await DesignSessionService.updateArtifacts(
              params.id,
              artifacts,
              current.artifactsVersion,
            )
          }

          // Restart the paused stage as a stream so the LLM continues with the
          // answer in context. `idle` predates toolset establishment and is kept
          // mapping to requirements for backwards compatibility.
          const pausedStage = current?.stage ?? session.stage
          const resumeStage =
            pausedStage === 'idle' ? 'requirements_drafting' : pausedStage
          const eventSource = draftingStageSource(
            resumeStage,
            params.id,
            abortController.signal,
          )
          if (!eventSource) {
            return { acknowledged: true, questionId }
          }

          return streamResponse(eventSource, params.id, request, user.id)
        }

        // Handle send_message — store and optionally restart stage
        if (action === 'send_message') {
          const { message, queue } = parsed.data
          if (!message) {
            throw new ValidationError('message is required for send_message')
          }

          // Mid-stream steering: the client holds an open drafting stream, so
          // don't restart it — enqueue into the mailbox the running stage loop
          // drains at its next check. If the stream died without draining, the
          // message is still picked up by drain-on-start of the next run.
          if (queue) {
            await DesignSessionService.enqueueGuidance(params.id, {
              id: crypto.randomUUID(),
              text: message,
              createdAt: new Date().toISOString(),
              stage: session.stage as DesignSessionStage,
            })
            return { queued: true }
          }

          const current = await DesignSessionService.getById(params.id)
          if (current?.artifacts) {
            const artifacts: DesignArtifacts = {
              ...current.artifacts,
              clarifications: current.artifacts.clarifications,
              userMessages: [
                ...current.artifacts.userMessages,
                {
                  id: crypto.randomUUID(),
                  text: message,
                  createdAt: new Date().toISOString(),
                  stage: current.stage as DesignSessionStage,
                },
              ],
            }
            await DesignSessionService.updateArtifacts(
              params.id,
              artifacts,
              current.artifactsVersion,
            )
          }

          // A review gate re-enters its drafting stage so the guidance (and any
          // open per-item comments) are folded into an in-place revision run; a
          // drafting stage just restarts. Non-re-runnable stages fall through.
          const currentStage = current?.stage ?? session.stage
          const eventSource = await reRunFromReview(
            currentStage,
            params.id,
            abortController.signal,
          )
          if (eventSource) {
            return streamResponse(eventSource, params.id, request, user.id)
          }

          // No drafting re-run for this stage — just acknowledge
          return { acknowledged: true }
        }

        // Handle revise — re-run the current gate's drafting stage to fold in
        // per-item comments (and any guidance) with no new message of its own.
        // A comment PATCH doesn't change the stage, so the session fetched at the
        // top of the handler still reflects the current gate.
        if (action === 'revise') {
          const eventSource = await reRunFromReview(
            session.stage,
            session.id,
            abortController.signal,
          )
          if (eventSource) {
            return streamResponse(eventSource, session.id, request, user.id)
          }
          return { acknowledged: true }
        }

        // Handle part regeneration
        if (action === 'regenerate_part') {
          const { tempId, feedback } = parsed.data
          if (!tempId) {
            throw new ValidationError('tempId is required for regenerate_part')
          }

          const eventSource = designEngine.regeneratePart(
            params.id,
            tempId,
            feedback ?? undefined,
            abortController.signal,
          )
          return streamResponse(eventSource, params.id, request, user.id)
        }

        // Handle streaming stages
        let eventSource: AsyncIterable<StageEvent>

        if (action === 'start_toolset') {
          eventSource = designEngine.runToolsetEstablishmentStage(
            params.id,
            abortController.signal,
          )
        } else if (action === 'start_requirements') {
          eventSource = designEngine.runRequirementsStage(
            params.id,
            abortController.signal,
          )
        } else if (action === 'start_bom') {
          eventSource = designEngine.runBomStage(
            params.id,
            abortController.signal,
          )
        } else if (action === 'start_cad_generation') {
          eventSource = designEngine.runCadGenerationStage(
            params.id,
            abortController.signal,
          )
        } else if (action === 'start_assembly_composition') {
          eventSource = designEngine.runAssemblyCompositionStage(
            params.id,
            abortController.signal,
          )
        } else {
          // 'resume' — continue whatever stage was in progress
          const source = draftingStageSource(
            session.stage,
            params.id,
            abortController.signal,
          )
          if (!source) {
            throw new ValidationError(
              `Cannot resume from stage: ${session.stage}`,
            )
          }
          eventSource = source
        }

        return streamResponse(eventSource, params.id, request, user.id)
      },
    ),
  ),
)

export default app
