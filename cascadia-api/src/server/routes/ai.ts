// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { EventType, chat, toServerSentEventsResponse } from '@tanstack/ai'
import { eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import { UsageAccumulator, recordLlmUsage } from '@/ai/usage'
import { apiHandler, created } from '@/api/handler'
import { aiSettingsUpdateSchema } from '@/api/schemas'
import {
  getAdapter,
  getAvailableProviders,
  isAIEnabled,
  loadProviderConfig,
} from '@/ai/adapters'
import { knowledgeService } from '@/ai/KnowledgeService'
import { sessionService } from '@/ai/SessionService'
import { dialogService } from '@/ai/dialogs/DialogService'
import { resolveChatScope } from '@/ai/chat-scope'
import { replayChatHistory } from '@/ai/history'
import { AccessControlService } from '@/auth/AccessControlService'
import { acquireStreamSlot, releaseStreamSlot } from '@/ai/stream-limits'
import { createSearchTools, createServerTools } from '@/ai/tools'
import {
  AlreadyExistsError,
  AppError,
  ErrorCode,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/errors'
import { aiSettings } from '@/db/schema/ai'
import { userRoles } from '@/db/schema/users'
import { db } from '@/db'
import { takeFirst } from '@/db/take-first'
// Register item types for KnowledgeService
import '@/items/registerItemTypes.server'

const adapt = tagged('AI')

/**
 * A chat turn, as `@tanstack/ai-client` posts it: an AG-UI `RunAgentInput`.
 *
 * Only two things are read from it. The newest user message is the turn — the
 * rest of the transcript is the server's own, loaded from the session, so the
 * client's copy of it is never trusted or replayed. And `forwardedProps.data`
 * carries the panel's session and mode (the connection's `body` option lands
 * in `forwardedProps`).
 *
 * A top-level `data` is still read. That is where the scope sat before the
 * client spoke AG-UI, and `{ messages: [{ role, content }], data }` is the
 * shape v1 of this API published — a caller written against it keeps working.
 *
 * The transcript is capped even though it is not replayed: an unbounded array
 * here is an unbounded request body. `content` is a string for a typed
 * message; the parts-based copy of the same message rides alongside it and is
 * the fallback.
 */
const wireMessageSchema = z.looseObject({
  role: z.string().max(32),
  content: z.unknown().optional(),
  parts: z.array(z.looseObject({ type: z.string() })).optional(),
})
type WireMessage = z.infer<typeof wireMessageSchema>

const chatDataSchema = z.object({
  sessionId: z.string().uuid().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  mode: z.enum(['chat', 'search']).optional(),
})

const chatRequestSchema = z.looseObject({
  messages: z.array(wireMessageSchema).max(500),
  forwardedProps: z.looseObject({ data: chatDataSchema.optional() }).optional(),
  data: chatDataSchema.optional(),
})

/** The longest single message the assistant will take. */
const MAX_MESSAGE_LENGTH = 100_000

/** The text of a wire message: its `content`, or its text parts joined. */
function wireMessageText(message: WireMessage): string {
  if (typeof message.content === 'string') return message.content
  return (message.parts ?? [])
    .map((part) =>
      part.type === 'text' && typeof part.content === 'string'
        ? part.content
        : '',
    )
    .join('')
}

const createSessionSchema = z.object({
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
})

/**
 * The per-program settings write. `provider` used to be checked here against
 * `['openai', 'anthropic']` while admin.ts accepted four — so a Gemini or
 * Ollama configuration was savable from one surface and not the other. Both
 * now share `aiSettingsUpdateSchema`; this adds the optional `programId` that
 * scopes the row.
 */
const aiSettingsWriteSchema = aiSettingsUpdateSchema
  .extend({
    programId: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()

/**
 * Get user roles from database
 */
async function getUserRoles(userId: string): Promise<Array<string>> {
  try {
    const userRoleRecords = await db.query.userRoles.findMany({
      where: eq(userRoles.userId, userId),
      with: {
        role: true,
      },
    })

    return userRoleRecords.map((ur) => ur.role.name)
  } catch (error) {
    console.error('[AI Chat] Error fetching user roles:', error)
    return []
  }
}

const app = new Hono()

// POST /api/ai/chat
app.post(
  '/chat',
  adapt(
    apiHandler(
      {
        body: chatRequestSchema,
        // Every accepted turn fans out to a paid provider and spends the
        // program's token budget, so the default API bucket is too generous
        // here. Production-gated like all limiting, so dev and tests are
        // unaffected.
        rateLimit: { windowMs: 60_000, maxRequests: 60 },
      },
      async ({ request, body, user, requestId }) => {
        const { messages: clientMessages } = body
        const data = body.forwardedProps?.data ?? body.data
        const sessionId = data?.sessionId
        const programId = data?.programId
        const designId = data?.designId
        const mode = data?.mode || 'chat'

        const userMessages = clientMessages.filter((m) => m.role === 'user')
        const latestUserMessage = userMessages[userMessages.length - 1]

        const message = latestUserMessage
          ? wireMessageText(latestUserMessage)
          : ''
        if (!message) {
          throw new ValidationError('Message is required')
        }
        if (message.length > MAX_MESSAGE_LENGTH) {
          throw new ValidationError(
            `Message is longer than ${MAX_MESSAGE_LENGTH} characters`,
          )
        }

        // Scope first. Everything below spends against a program — the API
        // key, the monthly token budget, the usage row, the program name in
        // the system prompt — and the body's programId is a claim, not a
        // fact. resolveChatScope turns it into the program this caller may
        // actually use, preferring an existing session's own scope.
        const scope = await resolveChatScope(
          user.id,
          { sessionId, programId, designId },
          sessionService,
        )
        const effectiveProgramId = scope.programId ?? undefined

        // Check if AI is enabled
        const aiEnabled = await isAIEnabled(effectiveProgramId)
        if (!aiEnabled) {
          // The 503 was hand-rolled here until FEATURE_DISABLED became a real
          // ErrorCode: same wire code and status, but now through
          // handleApiError, so the body carries the timestamp and requestId
          // every other error on this API does.
          throw new AppError(
            ErrorCode.FEATURE_DISABLED,
            'AI assistant is not enabled. Please configure AI settings or set API keys.',
          )
        }

        // Load or create session. Ownership was verified inside
        // resolveChatScope, which is also what decided the scope below.
        let session = scope.sessionId
          ? await sessionService.getSession(scope.sessionId)
          : null

        if (!session) {
          session = await sessionService.createSession(
            user.id,
            effectiveProgramId,
            scope.designId ?? undefined,
          )
        }

        // Load provider configuration
        const providerConfig = await loadProviderConfig(effectiveProgramId)
        const adapter = getAdapter(providerConfig)

        // Build schema context and system prompt
        const schemaContext = await knowledgeService.generateSchemaContext(
          session.programId || undefined,
          session.designId || undefined,
        )

        const roles = await getUserRoles(user.id)

        const promptContext = {
          schemaContext,
          user: {
            id: user.id,
            username: user.name || user.email,
            email: user.email,
            roles,
          },
          programName: session.program?.name,
          designName: session.design?.name,
        }

        const systemPrompt =
          mode === 'search'
            ? knowledgeService.buildSearchPrompt(promptContext)
            : knowledgeService.buildSystemPrompt(promptContext)

        // Get message history
        const history = await sessionService.getMessageHistory(session.id)

        // Save user message
        await sessionService.addMessage(session.id, {
          role: 'user',
          content: message,
        })

        // The transcript the model sees: the session's own history, then this
        // turn. The system prompt travels separately, in `systemPrompts`.
        // Stored tool calls are replayed paired with their results, which is
        // the only form a provider accepts them in — see `replayChatHistory`.
        const messages = [
          ...replayChatHistory(history),
          { role: 'user' as const, content: message },
        ]

        // Create abort controller for request cancellation
        const abortController = new AbortController()

        // Handle client disconnect
        request.signal.addEventListener('abort', () => {
          abortController.abort()
        })

        // Create AI tools with user context for permission checking
        const toolContext = {
          userId: user.id,
          sessionId: session.id,
          programId: session.programId || undefined,
          designId: session.designId || undefined,
          // A panel is rendering this session's results: tools may store
          // dialogs for it (see `@/ai/dialogs`).
          surface: mode,
        }
        const tools =
          mode === 'search'
            ? createSearchTools(toolContext)
            : createServerTools(toolContext)

        // Concurrent-stream cap: take a per-user slot before opening the LLM
        // stream (429 at the cap), and release it exactly once however the
        // stream ends — the transformed stream's finally covers completion,
        // abort, and error alike.
        acquireStreamSlot(user.id)
        let streamSlotReleased = false
        const releaseSlotOnce = () => {
          if (!streamSlotReleased) {
            streamSlotReleased = true
            releaseStreamSlot(user.id)
          }
        }

        // Stream chat response with tools.
        let stream: ReturnType<typeof chat>
        try {
          stream = chat({
            adapter,
            systemPrompts: [systemPrompt],
            messages,
            tools,
            // The session is the conversation: a stable thread id is also the
            // default prompt-cache key, so successive turns share a cache.
            threadId: session.id,
            // One tool at a time, in the order the model asked. The write
            // tools mint confirmation previews against the same session, and
            // an order the user did not see is not one to act on.
            toolExecution: 'sequential',
            abortController,
          })
        } catch (error) {
          releaseSlotOnce()
          throw error
        }

        // Token usage, summed across the model turns of this one request
        const usage = new UsageAccumulator()
        const streamStartedAt = Date.now()

        // Track assistant response for persistence. Text arrives as deltas
        // per message, and each model turn of the agent loop opens a new
        // message: what is persisted is the newest message that said
        // anything, so a turn's closing answer replaces the aside it made
        // before calling a tool.
        let fullResponse = ''
        let currentMessageId: string | undefined
        let currentMessageText = ''
        // Tool-call arguments stream in as JSON fragments keyed by the call
        // id; accumulate them and finalize once the stream completes.
        const toolCallAccum = new Map<
          string,
          { id: string; name: string; args: string }
        >()
        const collectedToolResults: Array<{
          toolCallId: string
          toolName: string
          content: string
        }> = []

        // Transform stream to save response after completion
        const transformedStream = async function* () {
          try {
            for await (const chunk of stream) {
              usage.observe(chunk)

              if (chunk.type === EventType.TEXT_MESSAGE_CONTENT) {
                if (chunk.messageId !== currentMessageId) {
                  currentMessageId = chunk.messageId
                  currentMessageText = ''
                }
                currentMessageText += chunk.delta
                fullResponse = currentMessageText
              }

              // A tool call opens with its id and name; its arguments follow
              // as fragments against the same id.
              if (chunk.type === 'TOOL_CALL_START') {
                toolCallAccum.set(chunk.toolCallId, {
                  id: chunk.toolCallId,
                  name: chunk.toolCallName,
                  args: '',
                })
              }
              if (chunk.type === EventType.TOOL_CALL_ARGS) {
                const entry = toolCallAccum.get(chunk.toolCallId)
                if (entry) entry.args += chunk.delta
              }

              // A result carries no tool name — resolve it from the call.
              if (chunk.type === EventType.TOOL_CALL_RESULT) {
                collectedToolResults.push({
                  toolCallId: chunk.toolCallId,
                  toolName: toolCallAccum.get(chunk.toolCallId)?.name ?? '',
                  // Our tools return JSON, which arrives as a string. A
                  // multimodal result (content parts) is stored as its JSON.
                  content:
                    typeof chunk.content === 'string'
                      ? chunk.content
                      : JSON.stringify(chunk.content),
                })
              }

              yield chunk
            }
          } finally {
            releaseSlotOnce()
            // Finalize accumulated tool calls (parse the completed argument JSON).
            const collectedToolCalls = Array.from(toolCallAccum.values())
              .filter((e) => e.id && e.name)
              .map((e) => {
                let args: Record<string, unknown> = {}
                try {
                  const parsed: unknown = JSON.parse(e.args || '{}')
                  if (typeof parsed === 'object' && parsed !== null) {
                    args = parsed as Record<string, unknown>
                  }
                } catch {
                  args = {}
                }
                return { id: e.id, name: e.name, arguments: args }
              })

            // Save assistant message with tool calls after stream completes
            if (fullResponse || collectedToolCalls.length > 0) {
              await sessionService.addMessage(session.id, {
                role: 'assistant',
                content: fullResponse || '',
                toolCalls:
                  collectedToolCalls.length > 0
                    ? collectedToolCalls
                    : undefined,
              })
            }

            // Save tool result messages
            for (const result of collectedToolResults) {
              await sessionService.addMessage(session.id, {
                role: 'tool',
                content: result.content,
                toolCallId: result.toolCallId,
                toolName: result.toolName,
              })
            }

            // One usage row per request, whatever the stream did — including
            // an abort partway through, which is precisely when the spend must
            // still be recorded. recordLlmUsage never throws.
            await recordLlmUsage({
              userId: user.id,
              sessionId: session.id,
              programId: session.programId ?? null,
              provider: providerConfig.provider,
              model: providerConfig.model,
              ...usage.totals,
              durationMs: Date.now() - streamStartedAt,
            })
          }
        }

        // Return SSE stream response
        return toServerSentEventsResponse(transformedStream(), {
          abortController,
          headers: {
            'X-Request-Id': requestId,
            'X-Session-Id': session.id,
          },
        })
      },
    ),
  ),
)

// GET /api/ai/sessions
app.get(
  '/sessions',
  adapt(
    apiHandler({}, async ({ user }) => {
      const sessions = await sessionService.getUserSessions(user.id)

      return { sessions, total: sessions.length }
    }),
  ),
)

// POST /api/ai/sessions
app.post(
  '/sessions',
  adapt(
    apiHandler(
      { body: createSessionSchema },
      async ({ body: { programId, designId }, user }) => {
        // Same rule as POST /chat: a session may only be scoped to a program
        // and design the caller can actually reach, because that scope is what
        // later requests spend against.
        const scope = await resolveChatScope(
          user.id,
          { programId, designId },
          sessionService,
        )

        const session = await sessionService.createSession(
          user.id,
          scope.programId ?? undefined,
          scope.designId ?? undefined,
        )

        return created({ session })
      },
    ),
  ),
)

// GET /api/ai/sessions/:id
app.get(
  '/sessions/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params

      // Verify ownership
      const isOwner = await sessionService.verifySessionOwnership(id, user.id)
      if (!isOwner) {
        throw new NotFoundError('Session', id)
      }

      const session = await sessionService.getSession(id)
      if (!session) {
        throw new NotFoundError('Session', id)
      }

      return { session }
    }),
  ),
)

// DELETE /api/ai/sessions/:id
app.delete(
  '/sessions/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params

      // Verify ownership
      const isOwner = await sessionService.verifySessionOwnership(id, user.id)
      if (!isOwner) {
        throw new NotFoundError('Session', id)
      }

      await sessionService.deleteSession(id)

      return new Response(null, { status: 204 })
    }),
  ),
)

// GET /api/ai/sessions/:id/messages
app.get(
  '/sessions/:id/messages',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params

      // Verify ownership
      const isOwner = await sessionService.verifySessionOwnership(id, user.id)
      if (!isOwner) {
        throw new NotFoundError('Session', id)
      }

      const messages = await sessionService.getMessageHistory(id)

      return { messages, total: messages.length }
    }),
  ),
)

// GET /api/ai/dialogs/:id
app.get(
  '/dialogs/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        openapi: {
          summary: 'Get the payload behind a chat dialog button',
        },
      },
      async ({ params, user }) => {
        // A dialog id travels through the model's context and the stored
        // transcript, so it is not a secret: the lookup names the caller as
        // well as the id, and an id that is not one at all is the same
        // not-found as one that belongs to someone else.
        const dialog = z.string().uuid().safeParse(params.id).success
          ? await dialogService.getForUser(params.id, user.id)
          : null
        if (!dialog) {
          throw new NotFoundError('Dialog', params.id)
        }
        return { dialog }
      },
    ),
  ),
)

// GET /api/ai/settings
app.get(
  '/settings',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const url = new URL(request.url)
      const programId = url.searchParams.get('programId')

      // Get settings
      let settings
      if (programId) {
        // A program's AI settings row names its provider, model, enabled flag
        // and — masked, but present — that it holds a key at all. Reading it
        // is reading the program, so membership decides. Writes stay on
        // system:manage (POST below).
        if (
          !(await AccessControlService.canAccessProgram(user.id, programId))
        ) {
          throw new PermissionDeniedError('program', 'access')
        }
        settings = await db.query.aiSettings.findFirst({
          where: eq(aiSettings.programId, programId),
        })
      } else {
        // Get global settings
        settings = await db.query.aiSettings.findFirst({
          where: isNull(aiSettings.programId),
        })
      }

      // Build response with available providers info
      return {
        settings: settings
          ? {
              id: settings.id,
              programId: settings.programId,
              provider: settings.provider,
              // Don't expose API keys in response
              config: {
                ...settings.config,
                apiKey: settings.config.apiKey ? '***' : undefined,
              },
              enabled: settings.enabled,
              createdAt: settings.createdAt,
              updatedAt: settings.updatedAt,
            }
          : null,
        availableProviders: getAvailableProviders(),
        hasEnvConfig: !!(
          process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY
        ),
      }
    }),
  ),
)

// POST /api/ai/settings
app.post(
  '/settings',
  adapt(
    apiHandler(
      // 'ai_settings' was never a ResourceType, and hasPermission() denies any
      // resource no role declares - so this endpoint 403'd for everyone,
      // administrators included. Admin config is 'system' everywhere else,
      // including admin.ts's own AI provider routes.
      { permission: ['system', 'manage'], body: aiSettingsWriteSchema },
      async ({ body }) => {
        const { programId, provider, config, enabled = true } = body

        // Check if settings already exist
        const existing = programId
          ? await db.query.aiSettings.findFirst({
              where: eq(aiSettings.programId, programId),
            })
          : await db.query.aiSettings.findFirst({
              where: isNull(aiSettings.programId),
            })

        if (existing) {
          throw new AlreadyExistsError(
            'AI settings',
            'this scope. Use PUT to update.',
          )
        }

        // Create settings
        const newSettings = takeFirst(
          await db
            .insert(aiSettings)
            .values({
              programId: programId || null,
              provider,
              config,
              enabled,
            })
            .returning(),
        )

        return created({
          id: newSettings.id,
          programId: newSettings.programId,
          provider: newSettings.provider,
          config: {
            ...newSettings.config,
            apiKey: newSettings.config.apiKey ? '***' : undefined,
          },
          enabled: newSettings.enabled,
          createdAt: newSettings.createdAt,
          updatedAt: newSettings.updatedAt,
        })
      },
    ),
  ),
)

// PUT /api/ai/settings
app.put(
  '/settings',
  adapt(
    apiHandler(
      // See POST /settings above: 'ai_settings' is not a ResourceType, so this
      // denied everyone. Admin config is 'system' everywhere else.
      { permission: ['system', 'manage'], body: aiSettingsWriteSchema },
      async ({ body }) => {
        const { programId, provider, config, enabled } = body

        // Find existing settings
        const existing = programId
          ? await db.query.aiSettings.findFirst({
              where: eq(aiSettings.programId, programId),
            })
          : await db.query.aiSettings.findFirst({
              where: isNull(aiSettings.programId),
            })

        if (!existing) {
          throw new NotFoundError(
            'AI settings for this scope. Use POST to create.',
          )
        }

        // Update settings
        const [updated] = await db
          .update(aiSettings)
          .set({
            provider,
            config,
            enabled: enabled !== undefined ? enabled : existing.enabled,
            updatedAt: new Date(),
          })
          .where(eq(aiSettings.id, existing.id))
          .returning()
        // Zero rows means the row was deleted between the read above and this
        // update — surface it rather than dereferencing undefined below.
        if (!updated) throw new NotFoundError('AI settings', existing.id)

        return {
          id: updated.id,
          programId: updated.programId,
          provider: updated.provider,
          config: {
            ...updated.config,
            apiKey: updated.config.apiKey ? '***' : undefined,
          },
          enabled: updated.enabled,
          createdAt: updated.createdAt,
          updatedAt: updated.updatedAt,
        }
      },
    ),
  ),
)

export default app
