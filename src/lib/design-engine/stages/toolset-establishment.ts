/**
 * Toolset Establishment Stage Processor
 *
 * Runs the LLM-powered toolset establishment stage.
 * Yields StageEvents as the LLM analyzes the description,
 * searches the user's tool library, and proposes a manufacturing toolset.
 *
 * Supports stop-and-restart on clarification: when the LLM asks a
 * clarification question, the generator stops and the SSE stream closes.
 * When the user answers, the stage is re-invoked with enriched context.
 */

import { chat } from '@tanstack/ai'
import { buildToolsetPrompt } from '../prompts/toolset-prompt'
import { createToolsetTools } from '../tools/toolset-tools'
import { DesignSessionService } from '../session-service'
import type { DesignSession } from '../session-service'
import type {
  DesignArtifacts,
  DesignSessionToolset,
  StageEvent,
} from '../types'
import { getAdapter, loadProviderConfig } from '@/lib/ai/adapters'

export async function* runToolsetEstablishmentStage(
  session: DesignSession,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  const isResuming = session.stage === 'toolset_establishment'

  // Only signal stage start if not resuming
  if (!isResuming) {
    yield { type: 'stage_change', stage: 'toolset_establishment' }
    await DesignSessionService.updateStage(session.id, 'toolset_establishment')
  }

  const artifacts: DesignArtifacts = session.artifacts ?? {
    description: session.description ?? '',
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }
  if (!artifacts.clarifications) artifacts.clarifications = []
  if (!artifacts.userMessages) artifacts.userMessages = []

  const description = artifacts.description || session.description || ''

  // Track latest toolset state
  let currentToolset: DesignSessionToolset = artifacts.toolset ?? {
    scope: 'unconstrained',
    tools: [],
  }

  // Clarification reference
  const clarificationRef: {
    requested: boolean
    data: {
      questionId: string
      question: string
      options?: Array<string>
    } | null
  } = { requested: false, data: null }

  // Create stage tools with callbacks
  const { tools } = createToolsetTools(
    session.programId ?? undefined,
    (toolset) => {
      currentToolset = toolset
    },
    (questionId, question, options) => {
      clarificationRef.requested = true
      clarificationRef.data = { questionId, question, options }
    },
  )

  try {
    // Load AI provider
    const providerConfig = await loadProviderConfig(
      session.programId ?? undefined,
    )
    const adapter = getAdapter(providerConfig)

    // Build system prompt
    const systemPrompt = buildToolsetPrompt(
      description,
      artifacts.clarifications.length > 0
        ? artifacts.clarifications
        : undefined,
      artifacts.userMessages.length > 0 ? artifacts.userMessages : undefined,
      isResuming && artifacts.toolset?.tools.length
        ? artifacts.toolset
        : undefined,
    )

    // Build messages
    const messages: any = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: isResuming
          ? 'Continue establishing the manufacturing toolset. Take into account all clarification answers and user guidance provided above.'
          : `Please analyze the following product description and establish a manufacturing toolset:\n\n${description}`,
      },
    ]

    // Create abort controller
    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort())
    }

    // Stream the LLM response
    const stream = chat({
      adapter,
      messages,
      tools,
      maxTokens: 8192,
      abortController,
    })

    let lastToolCount = artifacts.toolset?.tools.length ?? 0
    let accumulatedText = ''

    for await (const chunk of stream) {
      if (clarificationRef.requested || signal?.aborted) break

      // Yield text content
      if (chunk.type === 'content' && chunk.content) {
        const delta = chunk.content.slice(accumulatedText.length)
        accumulatedText = chunk.content
        if (delta) {
          yield { type: 'llm_text', text: delta }
        }
      }

      // Check for toolset changes and yield artifact updates
      if (currentToolset.tools.length !== lastToolCount) {
        const newTools = currentToolset.tools.slice(lastToolCount)
        for (const tool of newTools) {
          yield {
            type: 'tool_result',
            toolName: 'add_session_tool',
            result: { sessionToolId: tool.id, name: tool.name },
          }
        }

        artifacts.toolset = { ...currentToolset }
        yield {
          type: 'artifact_update',
          artifacts: { toolset: artifacts.toolset },
        }
        await DesignSessionService.updateArtifacts(session.id, artifacts)
        lastToolCount = currentToolset.tools.length
      }
    }

    // If clarification was requested, save progress and pause
    if (clarificationRef.requested && clarificationRef.data) {
      artifacts.toolset = { ...currentToolset }
      artifacts.pendingClarificationId = clarificationRef.data.questionId
      artifacts.pendingClarification = {
        id: clarificationRef.data.questionId,
        question: clarificationRef.data.question,
        options: clarificationRef.data.options,
      }
      await DesignSessionService.updateArtifacts(session.id, artifacts)

      yield {
        type: 'clarification_needed',
        questionId: clarificationRef.data.questionId,
        question: clarificationRef.data.question,
        options: clarificationRef.data.options,
      }

      yield { type: 'paused', reason: 'Waiting for your answer...' }
      return
    }

    // Final artifact update
    artifacts.toolset = { ...currentToolset }
    await DesignSessionService.updateArtifacts(session.id, artifacts)

    // Transition to review
    yield { type: 'stage_change', stage: 'toolset_review' }
    await DesignSessionService.updateStage(session.id, 'toolset_review')

    const toolCount = currentToolset.tools.length
    yield {
      type: 'stage_complete',
      stage: 'toolset_review',
      summary: `Established manufacturing toolset with ${toolCount} tool${toolCount !== 1 ? 's' : ''} (scope: ${currentToolset.scope}). Review the toolset in the Manufacturing panel, then confirm to proceed to requirements generation.`,
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Toolset establishment stage failed'
    yield { type: 'error', message }
    await DesignSessionService.updateStatus(session.id, 'failed', message)
  }
}
