/**
 * Requirements Stage Processor
 *
 * Runs the LLM-powered requirements generation stage.
 * Yields StageEvents as the LLM analyzes the description,
 * searches existing designs, and proposes structured requirements.
 *
 * Supports stop-and-restart on clarification: when the LLM asks a
 * clarification question, the generator stops and the SSE stream closes.
 * When the user answers, the stage is re-invoked with enriched context.
 */

import { chat, maxIterations } from '@tanstack/ai'
import { buildRequirementsPrompt } from '../prompts/requirements-prompt'
import { summarizeToolCalls } from '../prompts/tool-call-summary'
import { createRequirementsTools } from '../tools/requirements-tools'
import { DesignSessionService } from '../session-service'
import { effectiveReviewStatus, unresolvedComments } from '../types'
import { createToolEventTracker } from './tool-event-tracker'
import { buildSteeringUserMessage, createGuidanceChecker } from './guidance'
import { isResumingStage } from './resume'
import { streamChunkError, streamChunkErrorToError } from './stream-error'
import type { DesignSession } from '../session-service'
import type {
  DesignArtifacts,
  RequirementDraft,
  StageEvent,
  UserMessage,
} from '../types'
import { getAdapter, loadProviderConfig } from '@/lib/ai/adapters'

/** Cap the tool-calling loop so a search-then-propose sequence isn't cut short. */
const REQUIREMENTS_MAX_ITERATIONS = 20

/** Bound the number of mid-stream steering restarts per request. */
const MAX_STEERING_CONTINUATIONS = 5

export async function* runRequirementsStage(
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
    'requirements_drafting',
    artifacts.requirements.length > 0,
  )

  // Only signal stage start if not resuming
  if (!isResuming) {
    yield { type: 'stage_change', stage: 'requirements_drafting' }
    await DesignSessionService.updateStage(session.id, 'requirements_drafting')
  }

  // Collect proposed requirements (start from existing for resume)
  const proposedRequirements: Array<RequirementDraft> = [
    ...artifacts.requirements,
  ]

  // Build tool context — sessionId must be an ai_chat_sessions ID (for ai_usage_logs FK)
  const toolContext = {
    userId: session.userId,
    sessionId: session.aiChatSessionId ?? undefined,
    programId: session.programId,
    designId: session.designId ?? undefined,
  }

  // Create stage tools with callbacks
  // Use object wrapper to avoid TS narrowing issues with callback mutations
  const clarificationRef: {
    requested: boolean
    data: {
      questionId: string
      question: string
      options?: Array<string>
      multiSelect?: boolean
    } | null
  } = { requested: false, data: null }

  const tools = createRequirementsTools(
    toolContext,
    (requirement) => {
      // Structural dedup: same normalized name → return the existing tempId
      // instead of adding a duplicate (guards re-proposes on resume). A match
      // against a user-rejected requirement signals the rejection back to the
      // LLM instead of silently resurrecting it.
      const normalized = requirement.name.trim().toLowerCase()
      const existing = proposedRequirements.find(
        (r) => r.name.trim().toLowerCase() === normalized,
      )
      if (existing) {
        if (effectiveReviewStatus(existing) === 'rejected') {
          return {
            tempId: existing.tempId,
            added: false,
            rejectedByUser: true,
            message: `The user rejected "${existing.name}"${existing.reviewNote ? ` (reason: ${existing.reviewNote})` : ''} — do not re-propose it.`,
          }
        }
        return { tempId: existing.tempId, added: false }
      }
      proposedRequirements.push(requirement)
      return { tempId: requirement.tempId, added: true }
    },
    (questionId, question, options, multiSelect) => {
      // First clarification in a round wins — don't let a later one overwrite it.
      if (clarificationRef.requested) return
      clarificationRef.requested = true
      clarificationRef.data = { questionId, question, options, multiSelect }
    },
  )

  try {
    // Load AI provider
    const providerConfig = await loadProviderConfig(session.programId)
    const adapter = getAdapter(providerConfig)

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

    const priorToolCalls = isResuming
      ? summarizeToolCalls(session.llmHistory)
      : ''

    let lastRequirementsCount = artifacts.requirements.length
    // Guidance drained mid-stream; injected as the user turn of the next round
    let steeringMessages: Array<UserMessage> | null = null

    for (let round = 0; round <= MAX_STEERING_CONTINUATIONS; round++) {
      // Rebuild the prompt each round so steering guidance, rejections, and
      // current proposals are baked in.
      const rejectedRequirements = proposedRequirements.filter(
        (r) => effectiveReviewStatus(r) === 'rejected',
      )
      const requirementNames = new Map(
        proposedRequirements.map((r) => [r.tempId, r.name]),
      )
      const itemFeedback = unresolvedComments(
        artifacts.itemComments,
        'requirement',
      ).map((c) => ({
        targetName: requirementNames.get(c.targetTempId) ?? c.targetTempId,
        text: c.text,
      }))
      const includeExisting =
        (isResuming || round > 0) && proposedRequirements.length > 0
          ? [...proposedRequirements]
          : undefined
      const systemPrompt = buildRequirementsPrompt(
        description,
        artifacts.clarifications.length > 0
          ? artifacts.clarifications
          : undefined,
        artifacts.userMessages.length > 0 ? artifacts.userMessages : undefined,
        includeExisting,
        undefined,
        priorToolCalls || undefined,
        rejectedRequirements.length > 0 ? rejectedRequirements : undefined,
        itemFeedback.length > 0 ? itemFeedback : undefined,
      )

      const userContent = steeringMessages
        ? buildSteeringUserMessage(steeringMessages)
        : isResuming
          ? `Continue analyzing the product description and generate additional requirements. Take into account all clarification answers and user guidance provided above.`
          : `Please analyze the following product description and generate structured requirements:\n\n${description}`

      // Build messages - cast to satisfy TanStack AI's constrained message types
      const messages: any = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ]

      // Internal controller: aborted by the external signal AND by steering
      // (to cut the current chat short and restart with guidance injected).
      const abortController = new AbortController()
      if (signal) {
        signal.addEventListener('abort', () => abortController.abort())
      }

      // Stream the LLM response (16k tokens to accommodate multiple tool calls)
      const stream = chat({
        adapter,
        messages,
        tools,
        maxTokens: 16384,
        agentLoopStrategy: maxIterations(REQUIREMENTS_MAX_ITERATIONS),
        abortController,
      })

      const tracker = createToolEventTracker()
      let drainedSteering: Array<UserMessage> | null = null

      for await (const chunk of stream) {
        // Check if clarification was requested or abort signalled — break out of loop
        if (clarificationRef.requested || signal?.aborted) break

        // Adapter errors arrive as terminal error chunks, not throws — a loop
        // that ignores them mistakes a rejected request for an empty answer.
        const chunkError = streamChunkError(chunk)
        if (chunkError?.fatal) throw streamChunkErrorToError(chunkError)
        if (chunkError) {
          yield { type: 'llm_text', text: `\n\n_${chunkError.message}_\n\n` }
          continue
        }

        // Yield only the incremental text. The SDK resets its accumulated
        // `content` at the start of each agent-loop iteration (i.e. after every
        // tool call), so slicing against a persistent offset would drop the
        // leading characters of each post-tool-call message. `chunk.delta` is the
        // true per-chunk increment and is iteration-safe.
        if (chunk.type === 'content' && chunk.delta) {
          yield { type: 'llm_text', text: chunk.delta }
        }

        // Translate SDK tool chunks into tool_call/tool_result events so they're
        // captured into llmHistory (and shown in the activity feed).
        for (const ev of tracker.handle(chunk)) yield ev

        // Check for new requirements and yield artifact updates
        if (proposedRequirements.length > lastRequirementsCount) {
          artifacts.requirements = [...proposedRequirements]
          yield {
            type: 'artifact_update',
            artifacts: { requirements: artifacts.requirements },
          }
          await DesignSessionService.updateArtifacts(session.id, artifacts)
          lastRequirementsCount = proposedRequirements.length
        }

        // Mid-stream steering: internally throttled, so this is cheap to call
        // per chunk. On a hit, cut this chat short and restart with the
        // guidance injected as the next user turn.
        const drained = await guidance.maybeDrain()
        if (drained.length > 0) {
          drainedSteering = drained
          abortController.abort()
          break
        }
      }

      // If clarification was requested, save progress and pause
      if (clarificationRef.requested && clarificationRef.data) {
        // Save partial progress
        artifacts.requirements = [...proposedRequirements]
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
        // Generator ends here — SSE stream closes.
        // Stage stays at requirements_drafting so resume works.
        return
      }

      if (signal?.aborted) break

      if (drainedSteering) {
        artifacts.userMessages = [...artifacts.userMessages, ...drainedSteering]
        artifacts.requirements = [...proposedRequirements]
        await DesignSessionService.updateArtifacts(session.id, artifacts)
        for (const m of drainedSteering) {
          yield { type: 'user_message', id: m.id, text: m.text }
        }
        yield {
          type: 'llm_text',
          text: '\n\n_Incorporating your guidance..._\n\n',
        }
        steeringMessages = drainedSteering
        continue
      }

      // Normal completion
      break
    }

    // A run that proposed nothing has no requirements to review. Advancing to
    // `requirements_review` anyway strands the session: the review panel has
    // nothing to confirm and no stage offers a restart. Stay at
    // `requirements_drafting` so the user can retry or steer with a message.
    if (proposedRequirements.length === 0) {
      yield {
        type: 'error',
        message:
          'Requirements analysis finished without proposing any requirements. Start requirements analysis again, or send a message describing what to focus on.',
      }
      return
    }

    // Final artifact update
    artifacts.requirements = [...proposedRequirements]
    await DesignSessionService.updateArtifacts(session.id, artifacts)

    // Transition to review
    yield { type: 'stage_change', stage: 'requirements_review' }
    await DesignSessionService.updateStage(session.id, 'requirements_review')

    yield {
      type: 'stage_complete',
      stage: 'requirements_review',
      summary: `Generated ${proposedRequirements.length} requirements. Review and edit them in the left panel, then confirm to proceed to BOM generation.`,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Requirements stage failed'
    yield { type: 'error', message }
    await DesignSessionService.updateStatus(session.id, 'failed', message)
  }
}
