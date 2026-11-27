// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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

import { buildRequirementsPrompt } from '../prompts/requirements-prompt'
import { summarizeToolCalls } from '../prompts/tool-call-summary'
import { createRequirementsTools } from '../tools/requirements-tools'
import { DesignSessionService } from '../session-service'
import { effectiveReviewStatus, unresolvedComments } from '../types'
import { runAgentLoop } from './agent-loop'
import { buildSteeringUserMessage, createGuidanceChecker } from './guidance'
import { isResumingStage } from './resume'
import type { DesignSession } from '../session-service'
import type { DesignArtifacts, RequirementDraft, StageEvent } from '../types'
import { getAdapter, loadProviderConfig } from '@/ai/adapters'

/** Cap the tool-calling loop so a search-then-propose sequence isn't cut short. */
const REQUIREMENTS_MAX_ITERATIONS = 20

/** Bound the number of mid-stream steering restarts per request. */
const MAX_STEERING_CONTINUATIONS = 5

/**
 * How many clarification rounds the stage will run before it forces the model
 * to propose. Each `ask_clarification` pauses the stream, so a model that keeps
 * asking never reaches the proposing phase. Past this budget the clarification
 * tool is withdrawn and the prompt requires concrete proposals — without it a
 * session can loop indefinitely gathering context and produce nothing.
 */
const MAX_CLARIFICATION_ROUNDS = 6

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

  // Clarifications already asked and answered *for this stage*. Answers from
  // an earlier stage (e.g. toolset) don't count — they don't prove requirements
  // drafting has run.
  const clarificationRoundsUsed = artifacts.clarifications.filter(
    (c) => c.stage === 'requirements_drafting',
  ).length

  // A run is a continuation — not a fresh start — once the stage has produced
  // any requirements OR already gathered clarifications. Keying resume solely
  // on proposed requirements meant a session that only ever asked questions
  // (never proposed) restarted from scratch every round: re-running "search
  // first, ask liberally" and never advancing toward proposals.
  const hasPriorWork =
    artifacts.requirements.length > 0 || clarificationRoundsUsed > 0

  // Budget spent → stop asking and require proposals this run.
  const mustPropose = clarificationRoundsUsed >= MAX_CLARIFICATION_ROUNDS

  const isResuming = isResumingStage(
    session.stage,
    'requirements_drafting',
    hasPriorWork,
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
    { allowClarification: !mustPropose },
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
      maxTokens: 16384,
      maxIterations: REQUIREMENTS_MAX_ITERATIONS,
      guidance,
      clarificationRef,
      maxSteeringContinuations: MAX_STEERING_CONTINUATIONS,

      // Rebuilt each round so steering guidance, rejections and current
      // proposals are baked in.
      buildMessages: ({ steering }) => {
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
          (isResuming || steering) && proposedRequirements.length > 0
            ? [...proposedRequirements]
            : undefined
        const systemPrompt = buildRequirementsPrompt(
          description,
          artifacts.clarifications.length > 0
            ? artifacts.clarifications
            : undefined,
          artifacts.userMessages.length > 0
            ? artifacts.userMessages
            : undefined,
          includeExisting,
          undefined,
          priorToolCalls || undefined,
          rejectedRequirements.length > 0 ? rejectedRequirements : undefined,
          itemFeedback.length > 0 ? itemFeedback : undefined,
          mustPropose,
        )

        const userContent = steering
          ? buildSteeringUserMessage(steering)
          : isResuming
            ? `Continue analyzing the product description and generate additional requirements. Take into account all clarification answers and user guidance provided above.`
            : `Please analyze the following product description and generate structured requirements:\n\n${description}`

        return [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ]
      },

      persistDirtyArtifacts: async () => {
        if (proposedRequirements.length <= lastRequirementsCount) return null
        artifacts.requirements = [...proposedRequirements]
        lastRequirementsCount = proposedRequirements.length
        await DesignSessionService.updateArtifacts(session.id, artifacts)
        return {
          type: 'artifact_update',
          artifacts: { requirements: artifacts.requirements },
        }
      },

      applySteering: async (drained) => {
        artifacts.userMessages = [...artifacts.userMessages, ...drained]
        artifacts.requirements = [...proposedRequirements]
        await DesignSessionService.updateArtifacts(session.id, artifacts)
      },
    })

    // The caller aborted. Everything the model produced is already on disk —
    // `persistDirtyArtifacts` writes per chunk — so there is nothing left to
    // save, but the stage must not go on. Falling through advanced a
    // half-drafted session to `requirements_review` whenever the consumer
    // kept pulling after the abort (a `for await` that does not `break`, or
    // any caller draining the generator), stranding the user at a review
    // panel for requirements the run never finished proposing. Staying at
    // `requirements_drafting` is what makes the next run a resume.
    if (outcome.type === 'aborted') return

    // If clarification was requested, save progress and pause.
    if (outcome.type === 'clarification' && clarificationRef.data) {
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
      // Generator ends here — SSE stream closes. Stage stays at
      // requirements_drafting so resume works.
      return
    }

    // Guidance that arrived after the last steering continuation was spent is
    // kept rather than dropped: the next run folds it into its prompt.
    if (outcome.type === 'steering-exhausted') {
      artifacts.userMessages = [
        ...artifacts.userMessages,
        ...outcome.pendingSteering,
      ]
      artifacts.requirements = [...proposedRequirements]
      await DesignSessionService.updateArtifacts(session.id, artifacts)
      for (const m of outcome.pendingSteering) {
        yield { type: 'user_message', id: m.id, text: m.text }
      }
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
