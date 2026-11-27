// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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

import { buildToolsetPrompt } from '../prompts/toolset-prompt'
import { summarizeToolCalls } from '../prompts/tool-call-summary'
import { createToolsetTools } from '../tools/toolset-tools'
import { DesignSessionService } from '../session-service'
import { runAgentLoop } from './agent-loop'
import { buildSteeringUserMessage, createGuidanceChecker } from './guidance'
import { isResumingStage } from './resume'
import type { DesignSession } from '../session-service'
import type {
  DesignArtifacts,
  DesignSessionToolset,
  StageEvent,
} from '../types'
import { getAdapter, loadProviderConfig } from '@/ai/adapters'

/** Cap the tool-calling loop so a search-then-add sequence isn't cut short. */
const TOOLSET_MAX_ITERATIONS = 15

/**
 * Bound the number of mid-stream steering restarts per request.
 *
 * New behaviour: this stage had none, because it was a single pass. Moving it
 * onto the shared engine gives it steering *and* transient-failure retry for
 * free — a dropped socket used to end the stage outright.
 */
const MAX_STEERING_CONTINUATIONS = 5

export async function* runToolsetEstablishmentStage(
  session: DesignSession,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  const artifacts: DesignArtifacts = session.artifacts ?? {
    description: session.description ?? '',
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }
  const description = artifacts.description || session.description || ''

  const isResuming = isResumingStage(
    session.stage,
    'toolset_establishment',
    (artifacts.toolset?.tools.length ?? 0) > 0,
  )

  // Only signal stage start if not resuming
  if (!isResuming) {
    yield { type: 'stage_change', stage: 'toolset_establishment' }
    await DesignSessionService.updateStage(session.id, 'toolset_establishment')
  }

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
      multiSelect?: boolean
    } | null
  } = { requested: false, data: null }

  // Create stage tools with callbacks. Seed the builder with the current
  // toolset so a resumed stage adds to the existing tools instead of wiping
  // them (each tool mutation emits the full set).
  const { tools } = createToolsetTools(
    session.programId,
    (toolset) => {
      currentToolset = toolset
    },
    (questionId, question, options, multiSelect) => {
      // First clarification in a round wins — don't let a later one overwrite it.
      if (clarificationRef.requested) return
      clarificationRef.requested = true
      clarificationRef.data = { questionId, question, options, multiSelect }
    },
    currentToolset,
  )

  try {
    // Load AI provider
    const providerConfig = await loadProviderConfig(session.programId)
    const adapter = getAdapter(providerConfig)

    const priorToolCalls = isResuming
      ? summarizeToolCalls(session.llmHistory)
      : ''

    const guidance = createGuidanceChecker(session.id)

    // Guidance sent while no stream was running: fold it in before prompting.
    const startGuidance = await guidance.drain()
    if (startGuidance.length > 0) {
      artifacts.userMessages = [...artifacts.userMessages, ...startGuidance]
      await DesignSessionService.updateArtifacts(session.id, artifacts)
      for (const m of startGuidance) {
        yield { type: 'user_message', id: m.id, text: m.text }
      }
    }

    let lastToolCount = artifacts.toolset?.tools.length ?? 0

    const outcome = yield* runAgentLoop({
      session: {
        id: session.id,
        aiChatSessionId: session.aiChatSessionId,
        programId: session.programId,
        userId: session.userId,
      },
      adapter,
      provider: providerConfig.provider,
      model: providerConfig.model,
      signal,
      isResuming,
      tools,
      maxTokens: 8192,
      maxIterations: TOOLSET_MAX_ITERATIONS,
      guidance,
      clarificationRef,
      maxSteeringContinuations: MAX_STEERING_CONTINUATIONS,

      buildMessages: ({ steering }) => {
        const systemPrompt = buildToolsetPrompt(
          description,
          artifacts.clarifications.length > 0
            ? artifacts.clarifications
            : undefined,
          artifacts.userMessages.length > 0
            ? artifacts.userMessages
            : undefined,
          (isResuming || steering) && artifacts.toolset?.tools.length
            ? artifacts.toolset
            : undefined,
          priorToolCalls || undefined,
        )

        const userContent = steering
          ? buildSteeringUserMessage(steering)
          : isResuming
            ? 'Continue establishing the manufacturing toolset. Take into account all clarification answers and user guidance provided above.'
            : `Please analyze the following product description and establish a manufacturing toolset:\n\n${description}`

        return [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ]
      },

      persistDirtyArtifacts: async () => {
        if (currentToolset.tools.length === lastToolCount) return null
        artifacts.toolset = { ...currentToolset }
        lastToolCount = currentToolset.tools.length
        await DesignSessionService.updateArtifacts(session.id, artifacts)
        return {
          type: 'artifact_update',
          artifacts: { toolset: artifacts.toolset },
        }
      },

      applySteering: async (drained) => {
        artifacts.userMessages = [...artifacts.userMessages, ...drained]
        artifacts.toolset = { ...currentToolset }
        await DesignSessionService.updateArtifacts(session.id, artifacts)
      },
    })

    // The caller aborted. `persistDirtyArtifacts` has already written every
    // tool the run established, so nothing is lost by stopping here — but
    // falling through advanced a half-established toolset to `toolset_review`
    // whenever the consumer kept pulling after the abort. Staying at
    // `toolset_establishment` is what makes the next run a resume.
    if (outcome.type === 'aborted') return

    // Guidance that arrived after the last steering continuation was spent is
    // kept rather than dropped: the next run folds it into its prompt.
    if (outcome.type === 'steering-exhausted') {
      artifacts.userMessages = [
        ...artifacts.userMessages,
        ...outcome.pendingSteering,
      ]
      artifacts.toolset = { ...currentToolset }
      await DesignSessionService.updateArtifacts(session.id, artifacts)
      for (const m of outcome.pendingSteering) {
        yield { type: 'user_message', id: m.id, text: m.text }
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
        multiSelect: clarificationRef.data.multiSelect,
      }
      await DesignSessionService.updateArtifacts(session.id, artifacts)

      yield {
        type: 'clarification_needed',
        questionId: clarificationRef.data.questionId,
        question: clarificationRef.data.question,
        options: clarificationRef.data.options,
        multiSelect: clarificationRef.data.multiSelect,
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
