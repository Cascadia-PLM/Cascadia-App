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
  buildBomContinuationPrompt,
  buildBomPrompt,
} from '../prompts/bom-prompt'
import { createBomTools } from '../tools/bom-tools'
import { validateBomDraft } from '../validation/bom-validator'
import { DesignSessionService } from '../session-service'
import type { DesignSession } from '../session-service'
import type {
  BomDraft,
  BomNodeDraft,
  DesignArtifacts,
  ProposedPart,
  StageEvent,
} from '../types'
import { getAdapter, loadProviderConfig } from '@/lib/ai/adapters'

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
  // Backward compat
  if (!artifacts.clarifications) artifacts.clarifications = []
  if (!artifacts.userMessages) artifacts.userMessages = []

  const description = artifacts.description || session.description || ''

  // Build tool context — sessionId must be an ai_chat_sessions ID (for ai_usage_logs FK)
  const toolContext = {
    userId: session.userId,
    sessionId: session.aiChatSessionId ?? undefined,
    programId: session.programId ?? undefined,
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
    } | null
  } = { requested: false, data: null }

  const tools = createBomTools(
    toolContext,
    bomState,
    (bom) => {
      bomRef.current = bom
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

    // Build system prompt with clarification/user message context
    const systemPrompt = buildBomPrompt(
      description,
      artifacts.requirements,
      artifacts.clarifications.length > 0
        ? artifacts.clarifications
        : undefined,
      artifacts.userMessages.length > 0 ? artifacts.userMessages : undefined,
      isResuming && artifacts.bom ? artifacts.bom : undefined,
      undefined, // schemaContext
      artifacts.toolset ?? undefined,
    )

    // Build messages - cast to satisfy TanStack AI's constrained message types
    const messages: any = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: isResuming
          ? `Continue building the Bill of Materials. Take into account all clarification answers and user guidance provided above. Do not re-propose parts already in the tree.`
          : `Build a Bill of Materials for this design based on the confirmed requirements. Search for existing parts first, then propose new parts as needed.`,
      },
    ]

    // --- Stream-processing helper ---
    // Yields StageEvent items, returns whether a clarification was requested.
    // Uses `any` for streamIter to match chat()'s opaque return type.
    const processStream = async function* (
      streamIter: any,
    ): AsyncGenerator<StageEvent, boolean> {
      let lastBomVersion = bomState.changeVersion
      let accumulatedText = ''

      for await (const chunk of streamIter) {
        if (clarificationRef.requested || signal?.aborted) break

        if (chunk.type === 'content' && chunk.content) {
          const delta = (chunk.content as string).slice(accumulatedText.length)
          accumulatedText = chunk.content as string
          if (delta) {
            yield { type: 'llm_text', text: delta }
          }
        }

        if (bomRef.current && bomState.changeVersion > lastBomVersion) {
          artifacts.bom = bomRef.current
          yield {
            type: 'artifact_update',
            artifacts: { bom: bomRef.current },
          }
          await DesignSessionService.updateArtifacts(session.id, artifacts)
          lastBomVersion = bomState.changeVersion
        }
      }

      return clarificationRef.requested
    }

    // Create an abort controller that combines the external signal with internal needs
    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort())
    }

    // --- Initial chat call ---
    const stream = chat({
      adapter,
      messages,
      tools,
      maxTokens: 16384,
      agentLoopStrategy: maxIterations(30),
      abortController,
    })

    const initialStreamGen = processStream(stream)
    for (;;) {
      const result = await initialStreamGen.next()
      if (result.done) break
      yield result.value
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
        artifacts.requirements,
        artifacts.clarifications.length > 0
          ? artifacts.clarifications
          : undefined,
        artifacts.userMessages.length > 0 ? artifacts.userMessages : undefined,
        bomRef.current,
        undefined, // schemaContext
        artifacts.toolset ?? undefined,
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

      const contStreamGen = processStream(contStream)
      for (;;) {
        const result = await contStreamGen.next()
        if (result.done) break
        yield result.value
      }

      // If clarification was requested during continuation, pause
      if (clarificationRef.requested && clarificationRef.data) {
        const clarData = clarificationRef.data as {
          questionId: string
          question: string
          options?: Array<string>
        }
        if (bomRef.current) {
          artifacts.bom = bomRef.current
        }
        artifacts.pendingClarificationId = clarData.questionId
        artifacts.pendingClarification = {
          id: clarData.questionId,
          question: clarData.question,
          options: clarData.options,
        }
        await DesignSessionService.updateArtifacts(session.id, artifacts)

        yield {
          type: 'clarification_needed',
          questionId: clarData.questionId,
          question: clarData.question,
          options: clarData.options,
        }

        yield { type: 'paused', reason: 'Waiting for your answer...' }
        return
      }
    }

    // Run validation
    if (bomRef.current) {
      const issues = validateBomDraft(artifacts)
      bomRef.current.validationIssues = issues

      artifacts.bom = bomRef.current
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
