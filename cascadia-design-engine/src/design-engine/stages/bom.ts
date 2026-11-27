// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * BOM Stage Processor
 *
 * Runs the LLM-powered BOM generation stage.
 * The LLM decomposes the system into sub-assemblies,
 * searches for existing parts, proposes new parts,
 * and builds a hierarchical BOM tree.
 *
 * Supports stop-and-restart on clarification: when the LLM asks a
 * clarification question, the generator stops and the SSE stream closes.
 * When the user answers, the stage is re-invoked with enriched context.
 */

import {
  buildBomConsolidationPrompt,
  buildBomContinuationPrompt,
  buildBomPrompt,
} from '../prompts/bom-prompt'
import { summarizeToolCalls } from '../prompts/tool-call-summary'
import { createBomTools, createConsolidationTools } from '../tools/bom-tools'
import { validateBomDraft } from '../validation/bom-validator'
import { detectMirrorCandidates } from '../validation/mirror-detection'
import { DesignSessionService } from '../session-service'
import { activeRequirements, unresolvedComments } from '../types'
import { runAgentLoop } from './agent-loop'
import { buildSteeringUserMessage, createGuidanceChecker } from './guidance'
import { isResumingStage } from './resume'
import type { AgentLoopConfig } from './agent-loop'
import type { DesignSession } from '../session-service'
import type {
  BomDraft,
  BomNodeDraft,
  DesignArtifacts,
  ProposedPart,
  StageEvent,
  UserMessage,
  ValidationIssue,
} from '../types'
import { getAdapter, loadProviderConfig } from '@/ai/adapters'
import { UsageAccumulator, recordLlmUsage } from '@/ai/usage'

/** Bound the number of mid-stream steering restarts per request. */
const MAX_STEERING_CONTINUATIONS = 5

/**
 * How many clarification rounds the stage will run before it forces the model
 * to build. Each `ask_bom_clarification` pauses the stream, so a model that
 * keeps asking never reaches the proposing phase. Past this budget the
 * clarification tool is withdrawn and the prompt requires concrete parts —
 * without it a session can loop indefinitely gathering context and build
 * nothing.
 */
const MAX_CLARIFICATION_ROUNDS = 6

/**
 * Recursively collect all nodes from a BOM tree into a Map keyed by tempId.
 */
function collectNodes(
  node: BomNodeDraft,
  map: Map<string, BomNodeDraft>,
): void {
  map.set(node.tempId, node)
  for (const child of node.children) {
    collectNodes(child, map)
  }
}

/**
 * Detect gaps in the BOM that need additional LLM iterations.
 */
function detectBomGaps(bomState: {
  nodes: Map<string, BomNodeDraft>
  rootTempId: string | null
}): {
  undecomposedAssemblies: Array<{ tempId: string; name: string }>
  partsWithoutInterfaces: Array<{ tempId: string; name: string }>
  assembliesWithoutMappings: Array<{ tempId: string; name: string }>
  hasGaps: boolean
} {
  const undecomposedAssemblies: Array<{ tempId: string; name: string }> = []
  const partsWithoutInterfaces: Array<{ tempId: string; name: string }> = []
  const assembliesWithoutMappings: Array<{ tempId: string; name: string }> = []

  for (const node of Array.from(bomState.nodes.values())) {
    // Phantom nodes with 0 children are likely undecomposed assemblies
    if (
      node.partType === 'Phantom' &&
      node.children.length === 0 &&
      node.tempId !== bomState.rootTempId
    ) {
      undecomposedAssemblies.push({ tempId: node.tempId, name: node.name })
    }

    // New Manufacture parts should have interfaces for CAD generation
    if (
      node.isNew &&
      node.partType === 'Manufacture' &&
      (!node.interfaces || node.interfaces.length === 0)
    ) {
      partsWithoutInterfaces.push({ tempId: node.tempId, name: node.name })
    }

    // Assemblies with children should have interface mappings
    if (
      node.children.length > 0 &&
      (!node.interfaceMappings || node.interfaceMappings.length === 0)
    ) {
      assembliesWithoutMappings.push({ tempId: node.tempId, name: node.name })
    }
  }

  return {
    undecomposedAssemblies,
    partsWithoutInterfaces,
    assembliesWithoutMappings,
    hasGaps:
      undecomposedAssemblies.length > 0 ||
      partsWithoutInterfaces.length > 0 ||
      assembliesWithoutMappings.length > 0,
  }
}

export async function* runBomStage(
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

  // Clarifications already asked and answered *for this stage*. Answers from an
  // earlier stage (requirements, toolset) don't count — they don't prove BOM
  // drafting has run.
  const clarificationRoundsUsed = artifacts.clarifications.filter(
    (c) => c.stage === 'bom_drafting',
  ).length

  // A run is a continuation — not a fresh start — once the stage has produced
  // any BOM OR already gathered clarifications. Keying resume solely on the BOM
  // meant a session that only ever asked questions (never proposed a part)
  // restarted from scratch every round instead of advancing toward a tree.
  const hasPriorWork = artifacts.bom !== null || clarificationRoundsUsed > 0

  // Budget spent → stop asking and require parts this run.
  const mustPropose = clarificationRoundsUsed >= MAX_CLARIFICATION_ROUNDS

  const isResuming = isResumingStage(
    session.stage,
    'bom_drafting',
    hasPriorWork,
  )

  // Only signal stage start if not resuming
  if (!isResuming) {
    yield { type: 'stage_change', stage: 'bom_drafting' }
    await DesignSessionService.updateStage(session.id, 'bom_drafting')
  }

  // Build tool context — sessionId must be an ai_chat_sessions ID (for ai_usage_logs FK)
  const toolContext = {
    userId: session.userId,
    sessionId: session.aiChatSessionId ?? undefined,
    programId: session.programId,
    designId: session.designId ?? undefined,
  }

  // BOM build state — reconstruct from existing artifacts if resuming
  const bomState: {
    nodes: Map<string, BomNodeDraft>
    proposedParts: Array<ProposedPart>
    rootTempId: string | null
    changeVersion: number
  } = {
    nodes: new Map(),
    proposedParts: [],
    rootTempId: null,
    changeVersion: 0,
  }

  if (isResuming && artifacts.bom) {
    collectNodes(artifacts.bom.rootAssembly, bomState.nodes)
    bomState.proposedParts = [...artifacts.bom.proposedParts]
    bomState.rootTempId = artifacts.bom.rootAssembly.tempId
  }

  // Track BOM updates for streaming - use object wrapper so TS doesn't narrow incorrectly
  const bomRef: { current: BomDraft | null } = {
    current: artifacts.bom ?? null,
  }

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

  const tools = createBomTools(
    toolContext,
    bomState,
    (bom) => {
      bomRef.current = bom
    },
    (questionId, question, options, multiSelect) => {
      // First clarification in a round wins — don't let a later one overwrite it.
      if (clarificationRef.requested) return
      clarificationRef.requested = true
      clarificationRef.data = { questionId, question, options, multiSelect }
    },
    artifacts.bomRejections,
    { allowClarification: !mustPropose },
  )

  // One accumulator across every pass: an initial pass, gap continuations and
  // a consolidation pass are one *run*, however many requests they take. The
  // engine feeds it; the single row is written in the finally below.
  const usage = new UsageAccumulator()
  const startedAt = Date.now()
  let usageProvider: { provider: string | null; model: string | null } = {
    provider: null,
    model: null,
  }

  try {
    // Load AI provider
    const providerConfig = await loadProviderConfig(session.programId)
    const adapter = getAdapter(providerConfig)
    usageProvider = {
      provider: providerConfig.provider,
      model: providerConfig.model,
    }

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

    // Build system prompt with clarification/user message context
    const priorToolCalls = isResuming
      ? summarizeToolCalls(session.llmHistory)
      : ''
    // Per-node comments, resolved against current tree names
    const nodeNames = new Map<string, string>()
    if (artifacts.bom) {
      const collectNames = (n: BomNodeDraft) => {
        nodeNames.set(n.tempId, n.name)
        n.children.forEach(collectNames)
      }
      collectNames(artifacts.bom.rootAssembly)
    }
    const bomItemFeedback = unresolvedComments(
      artifacts.itemComments,
      'bom_node',
    ).map((c) => ({
      targetName: nodeNames.get(c.targetTempId) ?? c.targetTempId,
      text: c.text,
    }))
    // Fold drained steering into the artifacts and feed, then continue.
    let steeringCount = 0
    const applySteering = async (drained: Array<UserMessage>) => {
      steeringCount++
      artifacts.userMessages = [...artifacts.userMessages, ...drained]
      if (bomRef.current) artifacts.bom = bomRef.current
      await DesignSessionService.updateArtifacts(session.id, artifacts)
    }

    let lastBomVersion = bomState.changeVersion
    const persistDirtyArtifacts = async () => {
      if (!bomRef.current || bomState.changeVersion <= lastBomVersion) {
        return null
      }
      artifacts.bom = bomRef.current
      lastBomVersion = bomState.changeVersion
      await DesignSessionService.updateArtifacts(session.id, artifacts)
      return {
        type: 'artifact_update' as const,
        artifacts: { bom: bomRef.current },
      }
    }

    /** One pass of this stage on the shared engine. */
    const bomPass = (options: {
      buildMessages: AgentLoopConfig['buildMessages']
      tools: unknown
      maxTokens: number
      maxIterations: number
      /** 0 for the single-purpose passes, which restart from their own loop. */
      maxSteeringContinuations: number
    }) =>
      runAgentLoop({
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
        guidance,
        clarificationRef,
        persistDirtyArtifacts,
        applySteering,
        usage,
        ...options,
      })

    // --- Initial pass, restarted on mid-stream steering ---
    const initialOutcome = yield* bomPass({
      tools,
      maxTokens: 16384,
      maxIterations: 30,
      maxSteeringContinuations: MAX_STEERING_CONTINUATIONS,
      buildMessages: ({ steering }) => {
        const systemPrompt = buildBomPrompt(
          description,
          activeRequirements(artifacts.requirements),
          artifacts.clarifications.length > 0
            ? artifacts.clarifications
            : undefined,
          artifacts.userMessages.length > 0
            ? artifacts.userMessages
            : undefined,
          (isResuming || steering) && (bomRef.current ?? artifacts.bom)
            ? (bomRef.current ?? artifacts.bom)
            : undefined,
          undefined, // schemaContext
          artifacts.toolset ?? undefined,
          priorToolCalls || undefined,
          artifacts.bomRejections,
          bomItemFeedback.length > 0 ? bomItemFeedback : undefined,
          mustPropose,
        )

        const userContent = steering
          ? buildSteeringUserMessage(steering)
          : isResuming
            ? `Continue building the Bill of Materials. Take into account all clarification answers and user guidance provided above. Do not re-propose parts already in the tree.`
            : `Build a Bill of Materials for this design based on the confirmed requirements. Search for existing parts first, then propose new parts as needed.`

        return [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ]
      },
    })

    // The caller aborted during the initial pass. Each pass below is already
    // signal-guarded, but the tail of this stage was not: the continuation
    // loop broke, consolidation was skipped, and the run then advanced a
    // half-built tree to `bom_review` anyway. `return` rather than `throw`,
    // because the `finally` still has to write the run's usage row — the
    // tokens were spent whoever walked away.
    if (initialOutcome.type === 'aborted') return

    // Guidance that arrived after the last steering continuation was spent is
    // kept rather than dropped: it lands in userMessages for the next run.
    if (initialOutcome.type === 'steering-exhausted') {
      await applySteering(initialOutcome.pendingSteering)
      for (const m of initialOutcome.pendingSteering) {
        yield { type: 'user_message', id: m.id, text: m.text }
      }
    }

    // If clarification was requested, save progress and pause
    if (clarificationRef.requested && clarificationRef.data) {
      if (bomRef.current) {
        artifacts.bom = bomRef.current
      }
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

    // --- Continuation loop: fill gaps the initial pass missed ---
    const MAX_CONTINUATIONS = 3
    for (let cont = 0; cont < MAX_CONTINUATIONS; cont++) {
      if (signal?.aborted) break

      const gaps = detectBomGaps(bomState)
      if (!gaps.hasGaps) break

      yield {
        type: 'llm_text',
        text: `\n\nDetected incomplete areas — running continuation pass ${cont + 1}...\n`,
      }

      // Reset clarification state for the continuation
      clarificationRef.requested = false
      clarificationRef.data = null

      // One pass per gap round: the outer loop owns the restart, so the engine
      // reports drained steering rather than restarting itself.
      const contOutcome = yield* bomPass({
        tools,
        maxTokens: 16384,
        maxIterations: 30,
        maxSteeringContinuations: 0,
        buildMessages: () => [
          {
            role: 'system',
            // Rebuilt with current BOM state baked in.
            content: buildBomPrompt(
              description,
              activeRequirements(artifacts.requirements),
              artifacts.clarifications.length > 0
                ? artifacts.clarifications
                : undefined,
              artifacts.userMessages.length > 0
                ? artifacts.userMessages
                : undefined,
              bomRef.current,
              undefined, // schemaContext
              artifacts.toolset ?? undefined,
              priorToolCalls || undefined,
              artifacts.bomRejections,
              bomItemFeedback.length > 0 ? bomItemFeedback : undefined,
            ),
          },
          { role: 'user', content: buildBomContinuationPrompt(gaps) },
        ],
      })

      // Aborted mid-continuation: stop the whole stage, not just this pass.
      // The loop's own `signal?.aborted` check only ends the loop, which
      // still leaves the stage transition below to run.
      if (contOutcome.type === 'aborted') return

      // Steering during a gap-filling pass: fold the guidance in and repeat
      // this pass (bounded by the shared steering budget).
      if (contOutcome.type === 'steering-exhausted') {
        await applySteering(contOutcome.pendingSteering)
        for (const m of contOutcome.pendingSteering) {
          yield { type: 'user_message', id: m.id, text: m.text }
        }
        if (steeringCount < MAX_STEERING_CONTINUATIONS) {
          yield {
            type: 'llm_text',
            text: '\n\n_Incorporating your guidance..._\n\n',
          }
          cont--
          continue
        }
      }

      // If clarification was requested during continuation, pause.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated via closure callback
      if (clarificationRef.requested && clarificationRef.data) {
        const clarData = clarificationRef.data as {
          questionId: string
          question: string
          options?: Array<string>
          multiSelect?: boolean
        }
        if (bomRef.current) {
          artifacts.bom = bomRef.current
        }
        artifacts.pendingClarificationId = clarData.questionId
        artifacts.pendingClarification = {
          id: clarData.questionId,
          question: clarData.question,
          options: clarData.options,
          multiSelect: clarData.multiSelect,
        }
        await DesignSessionService.updateArtifacts(session.id, artifacts)

        yield {
          type: 'clarification_needed',
          questionId: clarData.questionId,
          question: clarData.question,
          options: clarData.options,
          multiSelect: clarData.multiSelect,
        }

        yield { type: 'paused', reason: 'Waiting for your answer...' }
        return
      }
    }

    // --- Logistical consolidation pass: merge mirrored/duplicate parts ---
    // The tree may be technically complete yet list mirror-image or repeated
    // parts as separate lines (e.g. "Frame Member, Left" + "Frame Member,
    // Right" instead of "Frame Member" x2). Detect candidate groups cheaply and
    // only spend an LLM call — which judges which groups are truly the same
    // manufactured item — when there is something to review.
    const consolidationNotes: Array<string> = []
    if (bomRef.current && !signal?.aborted) {
      const candidates = detectMirrorCandidates(bomRef.current.rootAssembly)
      if (candidates.length > 0) {
        yield {
          type: 'llm_text',
          text: `\n\nReviewing BOM for mirrored/duplicate parts (${candidates.length} candidate group(s))...\n`,
        }

        const consolidationTools = createConsolidationTools(
          bomState,
          (bom) => {
            bomRef.current = bom
          },
          (info) => {
            consolidationNotes.push(
              `Consolidated ${info.mergedCount + 1} mirrored parts into "${info.name}" (qty ${info.quantity}).`,
            )
          },
        )

        // A short single-purpose pass: no steering continuations, so drained
        // guidance comes back for the caller to fold in rather than restarting
        // a consolidation that has already half-run.
        const consOutcome = yield* bomPass({
          tools: consolidationTools,
          maxTokens: 8192,
          maxIterations: 20,
          maxSteeringContinuations: 0,
          buildMessages: () => [
            {
              role: 'system',
              content: buildBomConsolidationPrompt(bomRef.current!, candidates),
            },
            {
              role: 'user',
              content:
                'Review the candidate groups and consolidate every group whose members are the same manufactured item.',
            },
          ],
        })

        // Aborted during consolidation: the tree is whatever the passes
        // before it left, and validating and publishing it as a finished BOM
        // would claim a consolidation that did not run.
        if (consOutcome.type === 'aborted') return

        // Steering drained during consolidation: fold it in so it isn't lost
        // (it lands in userMessages for subsequent runs), but don't restart
        // this short single-purpose pass.
        if (consOutcome.type === 'steering-exhausted') {
          await applySteering(consOutcome.pendingSteering)
          for (const m of consOutcome.pendingSteering) {
            yield { type: 'user_message', id: m.id, text: m.text }
          }
        }
      }
    }

    // Run validation
    if (bomRef.current) {
      artifacts.bom = bomRef.current
      const issues = validateBomDraft(artifacts)
      const consolidationIssues: Array<ValidationIssue> =
        consolidationNotes.map((message) => ({ severity: 'info', message }))
      bomRef.current.validationIssues = [...consolidationIssues, ...issues]

      await DesignSessionService.updateArtifacts(session.id, artifacts)

      yield {
        type: 'artifact_update',
        artifacts: { bom: bomRef.current },
      }
    }

    // A run that proposed nothing has no BOM to review. Advancing to
    // `bom_review` anyway strands the session: the review panel has no tree to
    // confirm and no stage offers a restart. Stay at `bom_drafting` so the user
    // can retry or steer the model with a message.
    if (!bomRef.current) {
      yield {
        type: 'error',
        message:
          'BOM generation finished without proposing any parts. Start BOM generation again, or send a message describing where it should begin.',
      }
      return
    }

    // Transition to review
    yield { type: 'stage_change', stage: 'bom_review' }
    await DesignSessionService.updateStage(session.id, 'bom_review')

    // Count tree-connected nodes (not orphans stuck in the Map)
    const countTreeNodes = (node: BomNodeDraft): number =>
      1 + node.children.reduce((sum, c) => sum + countTreeNodes(c), 0)
    const root = bomState.rootTempId
      ? bomState.nodes.get(bomState.rootTempId)
      : null
    const treePartCount = root ? countTreeNodes(root) : 0
    const orphanCount = bomState.nodes.size - treePartCount

    // Count new vs existing by walking the tree and checking each node's origin
    let newCount = 0
    let existingCount = 0
    const countByOrigin = (node: BomNodeDraft) => {
      if (node.isNew) newCount++
      else existingCount++
      node.children.forEach(countByOrigin)
    }
    if (root) countByOrigin(root)

    let summary = `BOM structure built with ${treePartCount} items (${newCount} new, ${existingCount} reused). Review the tree in the left panel, then confirm to proceed to materialization.`
    if (orphanCount > 0) {
      summary += ` Warning: ${orphanCount} node(s) were not linked to the tree and have been excluded.`
    }

    yield {
      type: 'stage_complete',
      stage: 'bom_review',
      summary,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'BOM stage failed'
    yield { type: 'error', message }
    await DesignSessionService.updateStatus(session.id, 'failed', message)
  } finally {
    // One row for the whole stage run, whatever ended it. The engine writes
    // its own row only when it owns the accumulator; here the stage does,
    // because several passes share one.
    if (session.userId) {
      const totals = usage.totals
      await recordLlmUsage({
        userId: session.userId,
        sessionId: session.aiChatSessionId ?? null,
        programId: session.programId,
        provider: usageProvider.provider,
        model: usageProvider.model,
        inputTokens: totals.inputTokens,
        outputTokens: totals.outputTokens,
        durationMs: Date.now() - startedAt,
      })
    }
  }
}
