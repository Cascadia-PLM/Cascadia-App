import { Hono } from 'hono'
import { chat, toServerSentEventsResponse } from '@tanstack/ai'
import { eq, isNull } from 'drizzle-orm'
import { adapt } from '../adapter'
import type { AIProviderConfig } from '@/lib/db/schema/ai'
import { apiHandler, created } from '@/lib/api/handler'
import { getAdapter, getAvailableProviders, isAIEnabled, loadProviderConfig  } from '@/lib/ai/adapters'
import { knowledgeService } from '@/lib/ai/KnowledgeService'
import { sessionService } from '@/lib/ai/SessionService'
import { createSearchTools, createServerTools } from '@/lib/ai/tools'
import {
  AlreadyExistsError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { aiSettings } from '@/lib/db/schema/ai'
import { db } from '@/lib/db'
// Register item types for KnowledgeService
import '@/lib/items/registerItemTypes.server'

// TanStack AI request body format (from @tanstack/ai-client)
interface ChatRequestBody {
  messages: Array<ModelMessage>
  data?: {
    sessionId?: string
    programId?: string
    designId?: string
    mode?: 'chat' | 'search'
  }
}

// TanStack AI message format
interface ModelMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | null
}

// Request body for creating a session
interface CreateSessionRequest {
  programId?: string
  designId?: string
}

// Request body for creating/updating settings
interface SettingsRequest {
  programId?: string
  provider: string
  config: AIProviderConfig
  enabled?: boolean
}

/**
 * Get user roles from database
 */
async function getUserRoles(userId: string): Promise<Array<string>> {
  try {
    const { db } = await import('@/lib/db')
    const { userRoles } = await import('@/lib/db/schema')
    const { eq } = await import('drizzle-orm')

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
    apiHandler({}, async ({ request, user, requestId }) => {
      // Parse request body (TanStack AI format)
      const body: ChatRequestBody = await request.json()
      const { messages: clientMessages, data } = body
      const sessionId = data?.sessionId
      const programId = data?.programId
      const designId = data?.designId
      const mode = data?.mode || 'chat'

      // Get the latest user message from the client
      const userMessages = clientMessages?.filter((m) => m.role === 'user')
      const latestUserMessage = userMessages?.[userMessages.length - 1]

      if (!latestUserMessage?.content) {
        throw new ValidationError('Message is required')
      }

      const message = latestUserMessage.content

      // Check if AI is enabled
      const aiEnabled = await isAIEnabled(programId)
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

      // Load or create session
      let session
      if (sessionId) {
        // Verify session ownership
        const isOwner = await sessionService.verifySessionOwnership(
          sessionId,
          user.id,
        )
        if (!isOwner) {
          throw new PermissionDeniedError('session', 'access')
        }
        session = await sessionService.getSession(sessionId)
      }

      if (!session) {
        session = await sessionService.createSession(
          user.id,
          programId,
          designId,
        )
      }

      // Load provider configuration
      const providerConfig = await loadProviderConfig(programId)
      const adapter = getAdapter(providerConfig)

      // Build schema context and system prompt
      const schemaContext = await knowledgeService.generateSchemaContext(
        session.programId || undefined,
        session.designId || undefined,
      )

      // Get user roles
      const userRoles = await getUserRoles(user.id)

      const promptContext = {
        schemaContext,
        user: {
          id: user.id,
          username: user.name || user.email,
          email: user.email,
          roles: userRoles,
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

      // Stream chat response with tools
      const stream = chat({
        adapter,
        messages,
        tools,
        abortController,
      })

      // Track assistant response for persistence
      let fullResponse = ''
      const collectedToolCalls: Array<{
        id: string
        name: string
        arguments: Record<string, unknown>
      }> = []
      const collectedToolResults: Array<{
        toolCallId: string
        toolName: string
        content: string
      }> = []

      // Transform stream to save response after completion
      const transformedStream = async function* () {
        try {
          for await (const chunk of stream) {
            // Track text content (TanStack AI 'content' chunks contain full accumulated text)
            if (chunk.type === 'content') {
              fullResponse = chunk.content // Replace, not append - content is cumulative
            }

            // Track tool calls made by assistant
            if (chunk.type === 'tool-call') {
              collectedToolCalls.push({
                id: chunk.id,
                name: chunk.name,
                arguments:
                  typeof chunk.arguments === 'string'
                    ? JSON.parse(chunk.arguments)
                    : chunk.arguments,
              })
            }

            // Track tool results
            if (chunk.type === 'tool-result') {
              collectedToolResults.push({
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName || '',
                content:
                  typeof chunk.content === 'string'
                    ? chunk.content
                    : JSON.stringify(chunk.content),
              })
            }

            yield chunk
          }
        } finally {
          // Save assistant message with tool calls after stream completes
          if (fullResponse || collectedToolCalls.length > 0) {
            await sessionService.addMessage(session.id, {
              role: 'assistant',
              content: fullResponse || '',
              toolCalls:
                collectedToolCalls.length > 0 ? collectedToolCalls : undefined,
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
        }
      }

      // Return SSE stream response
      return toServerSentEventsResponse(transformedStream(), {
        headers: {
          'X-Request-Id': requestId,
          'X-Session-Id': session.id,
        },
      })
    }),
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
    apiHandler({}, async ({ request, user }) => {
      const body: CreateSessionRequest = await request.json()
      const { programId, designId } = body

      const session = await sessionService.createSession(
        user.id,
        programId,
        designId,
      )

      return created({ session })
    }),
  ),
)

// GET /api/ai/sessions/:id
app.get(
  '/sessions/:id',
  adapt(
    apiHandler({}, async ({ params, user }) => {
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
    apiHandler({}, async ({ params, user }) => {
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
    apiHandler({}, async ({ params, user }) => {
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
    apiHandler({}, async ({ request }) => {
      const url = new URL(request.url)
      const programId = url.searchParams.get('programId')

      // Get settings
      let settings
      if (programId) {
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
      { permission: ['ai_settings', 'create'] },
      async ({ request }) => {
        const body: SettingsRequest = await request.json()
        const { programId, provider, config, enabled = true } = body

        // Validate provider
        if (!['openai', 'anthropic'].includes(provider)) {
          throw new ValidationError(
            'Invalid provider. Must be one of: openai, anthropic',
          )
        }

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
        const [newSettings] = await db
          .insert(aiSettings)
          .values({
            programId: programId || null,
            provider,
            config,
            enabled,
          })
          .returning()

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
      { permission: ['ai_settings', 'update'] },
      async ({ request }) => {
        const body: SettingsRequest = await request.json()
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

        // Validate provider if provided
        if (provider && !['openai', 'anthropic'].includes(provider)) {
          throw new ValidationError(
            'Invalid provider. Must be one of: openai, anthropic',
          )
        }

        // Update settings
        const [updated] = await db
          .update(aiSettings)
          .set({
            provider: provider || existing.provider,
            config: config || existing.config,
            enabled: enabled !== undefined ? enabled : existing.enabled,
            updatedAt: new Date(),
          })
          .where(eq(aiSettings.id, existing.id))
          .returning()

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
