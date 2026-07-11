import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type {
  DesignArtifacts,
  DesignSessionStage,
  StageEvent,
} from '@/lib/design-engine/types'
import { apiHandler, created } from '@/lib/api/handler'
import { DesignSessionService } from '@/lib/design-engine/session-service'
import { DesignSnapshotService } from '@/lib/design-engine/snapshot-service'
import { MaterializationService } from '@/lib/design-engine/materialize'
import { designEngine } from '@/lib/design-engine/engine'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import {
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { requireSessionAccess } from '@/lib/auth/session-access'
import {
  designArtifactsPatchSchema,
  designSessionStageSchema,
  stageIndex,
} from '@/lib/design-engine/types'

const adapt = tagged('Design Engine')

const createSessionSchema = z.object({
  description: z.string().min(1, 'Description is required'),
  programId: z.string().uuid('Invalid program ID'),
  designId: z.string().uuid('Invalid design ID').optional(),
  aiChatSessionId: z.string().uuid('Invalid chat session ID').optional(),
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
    default:
      return null
  }
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
 */
function streamResponse(
  eventSource: AsyncIterable<StageEvent>,
  sessionId: string,
  request: Request,
): Response {
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        for await (const event of eventSource) {
          if (request.signal.aborted) break

          const sseData = encodeSSE('stage_event', event)
          controller.enqueue(encoder.encode(sseData))

          // Persist artifacts on updates
          if (event.type === 'artifact_update') {
            const current = await DesignSessionService.getById(sessionId)
            if (current?.artifacts) {
              const merged = {
                ...current.artifacts,
                ...event.artifacts,
              }
              await DesignSessionService.updateArtifacts(sessionId, merged)
            }
          }

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

const app = new Hono()

// GET /api/design-engine/sessions
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
    apiHandler({}, async ({ request, user }) => {
      const body = await request.json()
      const parsed = createSessionSchema.safeParse(body)

      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues
            .map((e: { message: string }) => e.message)
            .join(', '),
        )
      }

      // Validate program membership before creating session
      const canAccess = await AccessControlService.canAccessProgram(
        user.id,
        parsed.data.programId,
      )
      if (!canAccess) {
        throw new PermissionDeniedError('program', 'access')
      }

      const session = await DesignSessionService.create(user.id, parsed.data)

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
    apiHandler({}, async ({ params, request, user }) => {
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'write')

      const body = await request.json()

      // Update description
      if (typeof body.description === 'string') {
        const artifacts = session.artifacts ?? {
          description: '',
          requirements: [],
          bom: null,
          clarifications: [],
          userMessages: [],
        }
        artifacts.description = body.description
        await DesignSessionService.updateArtifacts(params.id, artifacts)
      }

      // Update artifacts directly (with validation)
      if (body.artifacts) {
        const parsed = designArtifactsPatchSchema.parse(body.artifacts)
        await DesignSessionService.updateArtifacts(
          params.id,
          parsed as DesignArtifacts,
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
    }),
  ),
)

// GET /api/design-engine/sessions/:id/snapshots — metadata only, newest first
app.get(
  '/sessions/:id/snapshots',
  adapt(
    apiHandler({}, async ({ params, user }) => {
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
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'read')

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
    apiHandler({}, async ({ params, request, user }) => {
      const session = await DesignSessionService.getById(params.id)

      if (!session) {
        throw new NotFoundError('DesignSession', params.id)
      }

      await requireSessionAccess(user.id, session, 'write')

      const body = await request.json()
      const parsed = streamActionSchema.safeParse(body)

      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues
            .map((e: { message: string }) => e.message)
            .join(', '),
        )
      }

      const { action } = parsed.data

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
          throw new ValidationError('targetStage is required for reopen_stage')
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
          await DesignSessionService.updateArtifacts(params.id, artifacts)
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

        return streamResponse(eventSource, params.id, request)
      }

      // Handle send_message — store and optionally restart stage
      if (action === 'send_message') {
        const { message } = parsed.data
        if (!message) {
          throw new ValidationError('message is required for send_message')
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
          await DesignSessionService.updateArtifacts(params.id, artifacts)
        }

        // If in a drafting stage, restart as streaming so the guidance is applied
        const currentStage = current?.stage ?? session.stage
        const eventSource = draftingStageSource(
          currentStage,
          params.id,
          abortController.signal,
        )
        if (eventSource) {
          return streamResponse(eventSource, params.id, request)
        }

        // For review/other stages, just acknowledge
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
        return streamResponse(eventSource, params.id, request)
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

      return streamResponse(eventSource, params.id, request)
    }),
  ),
)

export default app
