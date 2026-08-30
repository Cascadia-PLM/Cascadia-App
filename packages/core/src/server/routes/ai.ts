// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { chat, toServerSentEventsResponse } from '@tanstack/ai'
import { eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import { UsageAccumulator, recordLlmUsage } from '@/lib/ai/usage'
import { apiHandler, created } from '@/lib/api/handler'
import { aiSettingsUpdateSchema } from '@/lib/api/schemas'
import {
  getAdapter,
  getAvailableProviders,
  isAIEnabled,
  loadProviderConfig,
} from '@/lib/ai/adapters'
import { knowledgeService } from '@/lib/ai/KnowledgeService'
import { sessionService } from '@/lib/ai/SessionService'
import { resolveChatScope } from '@/lib/ai/chat-scope'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { acquireStreamSlot, releaseStreamSlot } from '@/lib/ai/stream-limits'
import { createSearchTools, createServerTools } from '@/lib/ai/tools'
import {
  AlreadyExistsError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { aiSettings } from '@/lib/db/schema/ai'
import { userRoles } from '@/lib/db/schema/users'
import { db } from '@/lib/db'
import { takeFirst } from '@/lib/db/take-first'
// Register item types for KnowledgeService
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('AI')

// TanStack AI request body format (from @tanstack/ai-client)
/**
 * A chat turn, in TanStack AI's request format. The transcript is capped:
 * an unbounded array here is an unbounded prompt, and the budget chokepoint
 * only sees the request after it has been assembled.
 */
const modelMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string().max(100_000).nullable(),
})
type ModelMessage = z.infer<typeof modelMessageSchema>

const chatRequestSchema = z.object({
  messages: z.array(modelMessageSchema).max(500),
  data: z
    .object({
      sessionId: z.string().uuid().optional(),
      programId: z.string().uuid().optional(),
      designId: z.string().uuid().optional(),
      mode: z.enum(['chat', 'search']).optional(),
    })
    .optional(),
})

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
      { body: chatRequestSchema },
      async ({ request, body, user, requestId }) => {
        const { messages: clientMessages, data } = body
        const sessionId = data?.sessionId
        const programId = data?.programId
        const designId = data?.designId
        const mode = data?.mode || 'chat'

        const userMessages = clientMessages.filter((m) => m.role === 'user')
        const latestUserMessage = userMessages[userMessages.length - 1]

        if (!latestUserMessage?.content) {
          throw new ValidationError('Message is required')
        }

        const message = latestUserMessage.content

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
          return new Response(
            JSON.stringify({
              error: {
                code: 'FEATURE_DISABLED',
                message:
                  'AI assistant is not enabled. Please configure AI settings or set API keys.',
              },
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
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

        // Build messages array in model format
        const messages: Array<ModelMessage> = [
          { role: 'system', content: systemPrompt },
          ...history.map((msg) => ({
            role: msg.role as 'user' | 'assistant',
            content: msg.content,
          })),
          { role: 'user', content: message },
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
        // The local ModelMessage shape matches at runtime; TanStack AI's
        // ConstrainedModelMessage narrows role/content in a way this plain
        // {role, content} list doesn't satisfy structurally.
        let stream: ReturnType<typeof chat>
        try {
          stream = chat({
            adapter,
            messages: messages as Parameters<typeof chat>[0]['messages'],
            tools,
            abortController,
          })
        } catch (error) {
          releaseSlotOnce()
          throw error
        }

        // Token usage, summed across the model turns of this one request
        const usage = new UsageAccumulator()
        const streamStartedAt = Date.now()

        // Track assistant response for persistence
        let fullResponse = ''
        // Tool-call arguments stream in incrementally as JSON fragments keyed by
        // `chunk.index`; accumulate them and finalize once the stream completes.
        const toolCallAccum = new Map<
          number,
          { id: string; name: string; args: string }
        >()
        // tool_result chunks carry no tool name — resolve it from the tool_call.
        const toolCallIdToName = new Map<string, string>()
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

              // Track text content (TanStack AI 'content' chunks contain full accumulated text)
              if (chunk.type === 'content') {
                fullResponse = chunk.content // Replace, not append - content is cumulative
              }

              // Accumulate streamed tool-call fragments (id/name arrive on the
              // first fragment; arguments concatenate across fragments per index).
              if (chunk.type === 'tool_call') {
                const entry = toolCallAccum.get(chunk.index) ?? {
                  id: '',
                  name: '',
                  args: '',
                }
                if (chunk.toolCall.id) entry.id = chunk.toolCall.id
                if (chunk.toolCall.function.name) {
                  entry.name = chunk.toolCall.function.name
                }
                entry.args += chunk.toolCall.function.arguments
                toolCallAccum.set(chunk.index, entry)
                if (entry.id && entry.name) {
                  toolCallIdToName.set(entry.id, entry.name)
                }
              }

              // Track tool results (name looked up via the toolCallId map).
              if (chunk.type === 'tool_result') {
                collectedToolResults.push({
                  toolCallId: chunk.toolCallId,
                  toolName: toolCallIdToName.get(chunk.toolCallId) ?? '',
                  content: chunk.content,
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
