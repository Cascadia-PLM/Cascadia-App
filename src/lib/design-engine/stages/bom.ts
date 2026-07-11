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

import { chat, maxIterations } from '@tanstack/ai'
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
import { createToolEventTracker } from './tool-event-tracker'
import { buildSteeringUserMessage, createGuidanceChecker } from './guidance'
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
import { getAdapter, loadProviderConfig } from '@/lib/ai/adapters'

/** Bound the number of mid-stream steering restarts per request. */
const MAX_STEERING_CONTINUATIONS = 5

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
  const isResuming = session.stage === 'bom_drafting'

  // Only signal stage start if not resuming
  if (!isResuming) {
    yield { type: 'stage_change', stage: 'bom_drafting' }
    await DesignSessionService.updateStage(session.id, 'bom_drafting')
  }

  const artifacts: DesignArtifacts = session.artifacts ?? {
    description: session.description ?? '',
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }
  const description = artifacts.description || session.description || ''

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
    // --- Stream-processing helper ---
    // Yields StageEvent items; returns any steering guidance drained
    // mid-stream (after aborting the passed chat controller). Clarifications
    // are surfaced via clarificationRef, checked by the caller.
    // Uses `any` for streamIter to match chat()'s opaque return type.
    const processStream = async function* (
      streamIter: any,
      chatAbort: AbortController,
    ): AsyncGenerator<StageEvent, { steering: Array<UserMessage> | null }> {
      let lastBomVersion = bomState.changeVersion
      // Fresh tracker per stream — pending args are keyed by a per-call index.
      const tracker = createToolEventTracker()

      for await (const chunk of streamIter) {
        if (clarificationRef.requested || signal?.aborted) break

        // Yield only the incremental text. The SDK resets its accumulated
        // `content` at the start of each agent-loop iteration (i.e. after every
        // tool call), so slicing against a persistent offset would drop the
        // leading characters of each post-tool-call message. `chunk.delta` is
        // the true per-chunk increment and is iteration-safe.
        if (chunk.type === 'content' && chunk.delta) {
          yield { type: 'llm_text', text: chunk.delta as string }
        }

        // Translate SDK tool chunks into tool_call/tool_result events so they're
        // captured into llmHistory (and shown in the activity feed).
        for (const ev of tracker.handle(chunk)) yield ev

        if (bomRef.current && bomState.changeVersion > lastBomVersion) {
          artifacts.bom = bomRef.current
          yield {
            type: 'artifact_update',
            artifacts: { bom: bomRef.current },
          }
          await DesignSessionService.updateArtifacts(session.id, artifacts)
          lastBomVersion = bomState.changeVersion
        }

        // Mid-stream steering: internally throttled, so this is cheap to call
        // per chunk. On a hit, cut this chat short and restart with the
        // guidance injected as the next user turn.
        const drained = await guidance.maybeDrain()
        if (drained.length > 0) {
          chatAbort.abort()
          return { steering: drained }
        }
      }

      return { steering: null }
    }

    // Fold drained steering into the artifacts and feed, then continue.
    let steeringCount = 0
    const applySteering = async (drained: Array<UserMessage>) => {
      steeringCount++
      artifacts.userMessages = [...artifacts.userMessages, ...drained]
      if (bomRef.current) artifacts.bom = bomRef.current
      await DesignSessionService.updateArtifacts(session.id, artifacts)
    }

    // --- Initial pass, restarted on mid-stream steering ---
    let steeringMessages: Array<UserMessage> | null = null
    for (;;) {
      const systemPrompt = buildBomPrompt(
        description,
        activeRequirements(artifacts.requirements),
        artifacts.clarifications.length > 0
          ? artifacts.clarifications
          : undefined,
        artifacts.userMessages.length > 0 ? artifacts.userMessages : undefined,
        (isResuming || steeringMessages) && (bomRef.current ?? artifacts.bom)
          ? (bomRef.current ?? artifacts.bom)
          : undefined,
        undefined, // schemaContext
        artifacts.toolset ?? undefined,
        priorToolCalls || undefined,
        artifacts.bomRejections,
        bomItemFeedback.length > 0 ? bomItemFeedback : undefined,
      )

      const userContent = steeringMessages
        ? buildSteeringUserMessage(steeringMessages)
        : isResuming
          ? `Continue building the Bill of Materials. Take into account all clarification answers and user guidance provided above. Do not re-propose parts already in the tree.`
          : `Build a Bill of Materials for this design based on the confirmed requirements. Search for existing parts first, then propose new parts as needed.`

      // Build messages - cast to satisfy TanStack AI's constrained message types
      const messages: any = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ]

      // Internal controller: aborted by the external signal AND by steering
      const abortController = new AbortController()
      if (signal) {
        signal.addEventListener('abort', () => abortController.abort())
      }

      const stream = chat({
        adapter,
        messages,
        tools,
        maxTokens: 16384,
        agentLoopStrategy: maxIterations(30),
        abortController,
      })

      const initialStreamGen = processStream(stream, abortController)
      let streamOutcome: { steering: Array<UserMessage> | null } = {
        steering: null,
      }
      for (;;) {
        const result = await initialStreamGen.next()
        if (result.done) {
          streamOutcome = result.value
          break
        }
        yield result.value
      }

      if (
        streamOutcome.steering &&
        !clarificationRef.requested &&
        !signal?.aborted &&
        steeringCount < MAX_STEERING_CONTINUATIONS
      ) {
        await applySteering(streamOutcome.steering)
        for (const m of streamOutcome.steering) {
          yield { type: 'user_message', id: m.id, text: m.text }
        }
        yield {
          type: 'llm_text',
          text: '\n\n_Incorporating your guidance..._\n\n',
        }
        steeringMessages = streamOutcome.steering
        continue
      }

      break
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

      // Rebuild prompt with current BOM state baked in
      const contSystemPrompt = buildBomPrompt(
        description,
        activeRequirements(artifacts.requirements),
        artifacts.clarifications.length > 0
          ? artifacts.clarifications
          : undefined,
        artifacts.userMessages.length > 0 ? artifacts.userMessages : undefined,
        bomRef.current,
        undefined, // schemaContext
        artifacts.toolset ?? undefined,
        priorToolCalls || undefined,
        artifacts.bomRejections,
        bomItemFeedback.length > 0 ? bomItemFeedback : undefined,
      )

      const contUserMessage = buildBomContinuationPrompt(gaps)

      const contMessages: any = [
        { role: 'system', content: contSystemPrompt },
        { role: 'user', content: contUserMessage },
      ]

      // Reset clarification state for the continuation
      clarificationRef.requested = false
      clarificationRef.data = null

      // Create a fresh abort controller for continuation (prior one may be exhausted)
      const contAbortController = new AbortController()
      if (signal) {
        signal.addEventListener('abort', () => contAbortController.abort())
      }

      const contStream = chat({
        adapter,
        messages: contMessages,
        tools,
        maxTokens: 16384,
        agentLoopStrategy: maxIterations(30),
        abortController: contAbortController,
      })

      const contStreamGen = processStream(contStream, contAbortController)
      let contOutcome: { steering: Array<UserMessage> | null } = {
        steering: null,
      }
      for (;;) {
        const result = await contStreamGen.next()
        if (result.done) {
          contOutcome = result.value
          break
        }
        yield result.value
      }

      // Steering during a gap-filling pass: fold the guidance in and repeat
      // this pass (bounded by the shared steering budget).
      if (
        contOutcome.steering &&
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- mutated via closure callback
        !clarificationRef.requested &&
        !signal?.aborted
      ) {
        await applySteering(contOutcome.steering)
        for (const m of contOutcome.steering) {
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

        const consMessages: any = [
          {
            role: 'system',
            content: buildBomConsolidationPrompt(bomRef.current, candidates),
          },
          {
            role: 'user',
            content:
              'Review the candidate groups and consolidate every group whose members are the same manufactured item.',
          },
        ]

        const consAbortController = new AbortController()
        if (signal) {
          signal.addEventListener('abort', () => consAbortController.abort())
        }

        const consStream = chat({
          adapter,
          messages: consMessages,
          tools: consolidationTools,
          maxTokens: 8192,
          agentLoopStrategy: maxIterations(20),
          abortController: consAbortController,
        })

        const consStreamGen = processStream(consStream, consAbortController)
        let consOutcome: { steering: Array<UserMessage> | null } = {
          steering: null,
        }
        for (;;) {
          const result = await consStreamGen.next()
          if (result.done) {
            consOutcome = result.value
            break
          }
          yield result.value
        }

        // Steering drained during consolidation: fold it in so it isn't lost
        // (it lands in userMessages for subsequent runs), but don't restart
        // this short single-purpose pass.
        if (consOutcome.steering) {
          await applySteering(consOutcome.steering)
          for (const m of consOutcome.steering) {
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
  }
}
