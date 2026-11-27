// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * CAD Generation Stage Processor
 *
 * Generates individual STEP files for each new Manufacture part: parametric
 * templates and mechanisms through the CadQuery worker, everything else
 * through the FreeCAD agent (`@/cad-generation/freecad-agent`), which has
 * the AI provider write a FreeCAD script and iterate on the worker's report.
 * Runs after materialization, which provides the tempId → itemId mapping the
 * vault files are attached under.
 *
 * Metering: the agent is invoked once per part, several in parallel, and
 * those are one *run* — so this stage owns a single `UsageAccumulator`, hands
 * it to every agent call, and writes one usage row in its `finally`, the way
 * the assembly stage does for its planner calls.
 */

import { DesignSessionService } from '../session-service'
import { unresolvedComments } from '../types'
import type { DesignSession } from '../session-service'
import type { BomNodeDraft, DesignArtifacts, StageEvent } from '../types'
import type { FreecadAgentResult } from '@/cad-generation/freecad-agent'
import {
  buildPartPromptContext,
  generateAllParts,
} from '@/cad-generation/part-generator'
import { generatePartWithFreecad } from '@/cad-generation/freecad-agent'
import { createProgressChannel } from '@/cad-generation/progress-channel'
import { buildCadPrompt } from '@/cad-generation/prompt-builder'
import {
  findAffectedAssemblies,
  markAssembliesStale,
  notifyStaleAssemblies,
} from '@/cad-generation/cascade-recompose'
import { UsageAccumulator, recordLlmUsage } from '@/ai/usage'

/** Provider/model the agent resolved, for the usage row. Set from a callback. */
interface ProviderRef {
  current: { provider: string | null; model: string | null } | null
}

/**
 * New Manufacture leaves that carry no geometry signal at all — no
 * parametric spec, no material, no CAD hint, no mechanism coverage. The
 * agent would have to guess their shape from the name alone.
 */
function collectAmbiguousParts(root: BomNodeDraft): Array<BomNodeDraft> {
  const mechanismCovered = new Set<string>()
  const ambiguous: Array<BomNodeDraft> = []
  const walk = (node: BomNodeDraft) => {
    if (node.mechanismTemplate) {
      for (const m of node.mechanismTemplate.partMapping) {
        mechanismCovered.add(m.tempId)
      }
    }
    for (const child of node.children) walk(child)
  }
  walk(root)
  const collect = (node: BomNodeDraft) => {
    if (
      node.isNew &&
      node.partType === 'Manufacture' &&
      node.children.length === 0 &&
      !node.parametricSpec &&
      !node.material &&
      !node.cadGenerationHint &&
      !mechanismCovered.has(node.tempId)
    ) {
      ambiguous.push(node)
    }
    for (const child of node.children) collect(child)
  }
  collect(root)
  return ambiguous
}

export async function* runCadGenerationStage(
  session: DesignSession,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  const isResuming = session.stage === 'cad_generation'
  if (!isResuming) {
    yield { type: 'stage_change', stage: 'cad_generation' }
    await DesignSessionService.updateStage(session.id, 'cad_generation')
  }

  const artifacts: DesignArtifacts = session.artifacts ?? {
    description: '',
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }

  if (!artifacts.bom) {
    yield { type: 'error', message: 'No BOM found for CAD generation' }
    return
  }

  if (!artifacts.materializationResult) {
    yield {
      type: 'error',
      message:
        'Materialization result not found. Run materialization before CAD generation.',
    }
    return
  }

  // Pre-flight ambiguity check: this stage has no LLM loop that could ask,
  // so a deterministic check pauses ONCE for under-specified parts before
  // spending minutes generating guesswork geometry.
  const stageClarifications = artifacts.clarifications.filter(
    (c) => c.stage === 'cad_generation',
  )
  const ambiguousParts = collectAmbiguousParts(artifacts.bom.rootAssembly)
  if (ambiguousParts.length > 0 && stageClarifications.length === 0) {
    const names = ambiguousParts.map((p) => `"${p.name}"`).join(', ')
    const questionId = crypto.randomUUID()
    const question = `${ambiguousParts.length} part(s) have no material or geometry hints: ${names}. Describe their shape/material (one line each), or answer "proceed" to generate from the part names alone.`
    artifacts.pendingClarificationId = questionId
    artifacts.pendingClarification = {
      id: questionId,
      question,
      context: { stage: 'cad_generation' },
    }
    await DesignSessionService.updateArtifacts(session.id, artifacts)

    yield { type: 'clarification_needed', questionId, question }
    yield { type: 'paused', reason: 'Waiting for your answer...' }
    // Stage stays at cad_generation; answer_clarification resumes it.
    return
  }

  // Fold a prior clarification answer into the ambiguous parts' CAD hints
  // (an answer of "proceed" means generate as-is).
  const lastAnswer = stageClarifications[stageClarifications.length - 1]?.answer
  if (lastAnswer && lastAnswer.trim().toLowerCase() !== 'proceed') {
    for (const part of ambiguousParts) {
      part.cadGenerationHint = `User guidance for under-specified parts: ${lastAnswer}`
    }
    await DesignSessionService.updateArtifacts(session.id, artifacts)
  }

  // Build tempId → itemId mapping from materialization result
  const tempIdToItemId = new Map<string, string>()
  for (const item of artifacts.materializationResult.createdItems) {
    tempIdToItemId.set(item.tempId, item.itemId)
  }

  // One accumulator for the whole run; the single row is written in the
  // finally below. Null provider until an agent call actually resolved one —
  // a run whose every part was parametric never reached the model, and a
  // usage row for it would claim an LLM call that never happened.
  const usage = new UsageAccumulator()
  const providerRef: ProviderRef = { current: null }
  const startedAt = Date.now()

  try {
    // Resolve branchId from the materialized design's ECO-design relationship
    let branchId: string | undefined
    if (artifacts.materializationResult.ecoId) {
      try {
        const { db } = await import('@/db')
        const { changeOrderDesigns } = await import('@/db/schema/items')
        const { eq } = await import('drizzle-orm')
        const [cod] = await db
          .select({ branchId: changeOrderDesigns.branchId })
          .from(changeOrderDesigns)
          .where(
            eq(
              changeOrderDesigns.changeOrderId,
              artifacts.materializationResult.ecoId,
            ),
          )
          .limit(1)
        branchId = cod?.branchId ?? undefined
      } catch {
        // Non-critical — parametric parts report the missing branch as their
        // failure; FreeCAD parts still generate, attached to no branch.
      }
    }

    // Run part generation, forwarding all events (checking abort between each).
    //
    // Every artifact_update is persisted before it is forwarded, like every
    // other stage generator: `generateAllParts` mutates the BOM nodes in
    // place — they are the same objects `artifacts.bom` holds — so a write
    // here captures each finished part's status the moment its STEP file
    // lands in the vault. Without it, an abort, a crash or a claim
    // displacement threw away the whole run's statuses while the files
    // stayed in the vault, and the resume filter re-ran every part's agent
    // loop from scratch. Non-CAS by design (session-service's documented
    // policy): the stream claim makes this generator the session's only
    // streaming writer.
    for await (const event of generateAllParts(artifacts.bom.rootAssembly, {
      tempIdToItemId,
      productDescription: artifacts.description,
      branchId,
      userId: session.userId,
      programId: session.programId,
      signal,
      usage,
      onProviderResolved: (resolved) => {
        providerRef.current = resolved
      },
    })) {
      if (signal?.aborted) break
      if (event.type === 'artifact_update') {
        if (event.artifacts.cadGenerationState) {
          artifacts.cadGenerationState = event.artifacts.cadGenerationState
        }
        await DesignSessionService.updateArtifacts(session.id, artifacts)
      }
      yield event
    }

    // Count actual results from mutated BOM nodes
    const cadLeaves = collectLeafManufactureParts(artifacts.bom.rootAssembly)
    const completedCount = cadLeaves.filter(
      (p) => p.cadGeneration?.status === 'complete',
    ).length
    const failedCount = cadLeaves.filter(
      (p) => p.cadGeneration?.status === 'failed',
    ).length

    // Set cadGenerationState on artifacts so it persists and the summary is correct
    artifacts.cadGenerationState = {
      status: failedCount === cadLeaves.length ? 'failed' : 'complete',
      partsTotal: cadLeaves.length,
      // The parts that actually generated, not the parts that were tried —
      // this used to report every leaf as completed even when generation
      // failed on half of them, contradicting the summary line right below it.
      partsCompleted: completedCount,
      partsFailed: failedCount,
      assembliesTotal: 0,
      assembliesCompleted: 0,
      assembliesFailed: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }

    // Persist updated BOM with cadGeneration status on each node
    await DesignSessionService.updateArtifacts(session.id, artifacts)

    // Send updated BOM + state to client so CadReviewPanel sees per-node status
    yield {
      type: 'artifact_update',
      artifacts: {
        bom: artifacts.bom,
        cadGenerationState: artifacts.cadGenerationState,
      },
    }

    // Transition to review
    yield { type: 'stage_change', stage: 'cad_review' }
    await DesignSessionService.updateStage(session.id, 'cad_review')

    yield {
      type: 'stage_complete',
      stage: 'cad_review',
      summary: `CAD generation complete: ${completedCount}/${cadLeaves.length} parts generated successfully${failedCount > 0 ? `, ${failedCount} failed` : ''}. Review the results, then proceed to assembly.`,
    }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'CAD generation stage failed'
    yield { type: 'error', message }
    await DesignSessionService.updateStatus(session.id, 'failed', message)
  } finally {
    await recordStageUsage(session, usage, providerRef, startedAt)
  }
}

/**
 * Regenerate a single part's CAD with optional user feedback.
 * After regeneration, marks ancestor assemblies as stale.
 */
export async function* regeneratePartCad(
  session: DesignSession,
  tempId: string,
  feedback?: string,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  const artifacts: DesignArtifacts = session.artifacts ?? {
    description: '',
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }

  if (!artifacts.bom || !artifacts.materializationResult) {
    yield { type: 'error', message: 'Missing BOM or materialization data' }
    return
  }

  // Find the part node
  const partNode = findNode(artifacts.bom.rootAssembly, tempId)
  if (!partNode) {
    yield { type: 'error', message: `Part ${tempId} not found in BOM` }
    return
  }

  const itemId = artifacts.materializationResult.createdItems.find(
    (i) => i.tempId === tempId,
  )?.itemId
  if (!itemId) {
    yield { type: 'error', message: `No materialized item for ${tempId}` }
    return
  }

  yield {
    type: 'llm_text',
    text: `Regenerating CAD for "${partNode.name}"${feedback ? ` with feedback: ${feedback}` : ''}...`,
  }

  // Use parametric path if part has a parametric spec
  if (partNode.parametricSpec) {
    yield* regenerateParametric(
      session,
      artifacts,
      partNode,
      tempId,
      itemId,
      signal,
    )
    return
  }

  yield* regenerateFreecad(
    session,
    artifacts,
    partNode,
    tempId,
    itemId,
    feedback,
    signal,
  )
}

function findNode(root: BomNodeDraft, tempId: string): BomNodeDraft | null {
  if (root.tempId === tempId) return root
  for (const child of root.children) {
    const found = findNode(child, tempId)
    if (found) return found
  }
  return null
}

function findParent(
  root: BomNodeDraft,
  tempId: string,
): BomNodeDraft | undefined {
  for (const child of root.children) {
    if (child.tempId === tempId) return root
    const found = findParent(child, tempId)
    if (found) return found
  }
  return undefined
}

/**
 * Regenerate a part with the FreeCAD agent, relaying its per-attempt progress
 * and folding the feedback and unresolved comments into the specification.
 * The previous script travels with the request so the model revises rather
 * than starts over.
 */
async function* regenerateFreecad(
  session: DesignSession,
  artifacts: DesignArtifacts,
  partNode: BomNodeDraft,
  tempId: string,
  itemId: string,
  feedback: string | undefined,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  const usage = new UsageAccumulator()
  const providerRef: ProviderRef = { current: null }
  const startedAt = Date.now()

  try {
    // Fold unresolved per-part comments into the regeneration feedback
    const partComments = unresolvedComments(
      artifacts.itemComments,
      'bom_node',
      tempId,
    ).map((c) => c.text)
    const combinedFeedback =
      [feedback, ...partComments].filter(Boolean).join('\n') || undefined

    const promptContext = buildPartPromptContext(
      partNode,
      artifacts.bom
        ? findParent(artifacts.bom.rootAssembly, tempId)
        : undefined,
      artifacts.description,
    )
    promptContext.additionalFeedback = combinedFeedback

    // Resolve branchId from the ECO-design relationship, so the replacement
    // STEP lands on the same branch as the original. Non-critical.
    let branchId: string | undefined
    if (artifacts.materializationResult?.ecoId) {
      try {
        const { db } = await import('@/db')
        const { changeOrderDesigns } = await import('@/db/schema/items')
        const { eq } = await import('drizzle-orm')
        const [cod] = await db
          .select({ branchId: changeOrderDesigns.branchId })
          .from(changeOrderDesigns)
          .where(
            eq(
              changeOrderDesigns.changeOrderId,
              artifacts.materializationResult.ecoId,
            ),
          )
          .limit(1)
        branchId = cod?.branchId ?? undefined
      } catch {
        // Attach to no branch rather than fail the regeneration.
      }
    }

    // The agent runs as a promise; its progress lines are relayed as they
    // arrive rather than after it finishes, which for a multi-attempt part is
    // the difference between a live log and a minutes-long silence.
    const progress = createProgressChannel()
    const agentRun: Promise<{ done: true; result: FreecadAgentResult }> =
      generatePartWithFreecad({
        promptContext,
        partName: partNode.name,
        userId: session.userId,
        itemId,
        branchId,
        programId: session.programId,
        previousScript: partNode.cadGeneration?.generationScript,
        signal,
        usage,
        onProviderResolved: (resolved) => {
          providerRef.current = resolved
        },
        onProgress: (event) => progress.push(event.text),
      }).then((result) => ({ done: true as const, result }))

    let outcome: FreecadAgentResult | undefined
    while (!outcome) {
      const settled = await Promise.race([
        agentRun,
        progress.wait().then(() => ({ done: false as const })),
      ])
      for (const text of progress.drain()) {
        yield { type: 'llm_text', text }
      }
      if (settled.done) outcome = settled.result
    }

    if (!outcome.success) {
      throw new Error(outcome.errorMessage)
    }

    partNode.cadGeneration = {
      status: 'complete',
      generationMethod: 'freecad',
      stepFileKey: outcome.vaultFileId,
      boundingBox: outcome.boundingBox,
      generationScript: outcome.script,
      iterations: outcome.iterations,
      promptUsed: buildCadPrompt(promptContext),
    }

    yield {
      type: 'llm_text',
      text: `Successfully regenerated CAD for "${partNode.name}"${outcome.summary ? ` — ${outcome.summary}` : '.'}`,
    }

    // Mark ancestor assemblies as stale
    if (artifacts.bom) {
      const affected = findAffectedAssemblies(
        tempId,
        artifacts.bom.rootAssembly,
      )
      if (affected.length > 0) {
        markAssembliesStale(artifacts.bom.rootAssembly, affected)
        yield* notifyStaleAssemblies(artifacts.bom.rootAssembly, affected)
      }
    }

    // Persist
    await DesignSessionService.updateArtifacts(session.id, artifacts)

    yield {
      type: 'artifact_update',
      artifacts: { bom: artifacts.bom },
    }
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : 'Regeneration failed'
    partNode.cadGeneration = {
      status: 'failed',
      generationMethod: 'freecad',
      errorMessage: errMsg,
      // Keep the last good script: the next regeneration revises it.
      generationScript: partNode.cadGeneration?.generationScript,
    }

    yield {
      type: 'llm_text',
      text: `Failed to regenerate "${partNode.name}": ${errMsg}`,
    }

    await DesignSessionService.updateArtifacts(session.id, artifacts)

    yield {
      type: 'artifact_update',
      artifacts: { bom: artifacts.bom },
    }
  } finally {
    await recordStageUsage(session, usage, providerRef, startedAt)
  }
}

/**
 * Regenerate a parametric part by submitting a new job and polling for completion.
 */
async function* regenerateParametric(
  session: DesignSession,
  artifacts: DesignArtifacts,
  partNode: BomNodeDraft,
  tempId: string,
  itemId: string,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  try {
    // Resolve branchId from ECO-design relationship
    let branchId: string | undefined
    if (artifacts.materializationResult?.ecoId) {
      const { db } = await import('@/db')
      const { changeOrderDesigns } = await import('@/db/schema/items')
      const { eq } = await import('drizzle-orm')
      const [cod] = await db
        .select({ branchId: changeOrderDesigns.branchId })
        .from(changeOrderDesigns)
        .where(
          eq(
            changeOrderDesigns.changeOrderId,
            artifacts.materializationResult.ecoId,
          ),
        )
        .limit(1)
      branchId = cod?.branchId ?? undefined
    }

    if (!branchId) {
      yield {
        type: 'error',
        message: `Cannot resolve branchId for parametric regeneration of ${tempId}`,
      }
      return
    }

    const { JobService } = await import('@/jobs/JobService')

    const job = await JobService.submit(
      'generation.cad.parametric',
      {
        partTempId: tempId,
        partName: partNode.name,
        itemId,
        branchId,
        userId: session.userId,
        spec: partNode.parametricSpec,
      },
      session.userId,
      { priority: 'high', itemId },
    )

    // Poll for completion
    const maxWaitMs = 60_000
    const pollIntervalMs = 500
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      if (signal?.aborted) break
      const current = await JobService.get(job.id)
      if (!current) break

      if (current.status === 'completed' && current.result) {
        const result = current.result as {
          vaultFileId: string
          boundingBox?: {
            minX: number
            minY: number
            minZ: number
            maxX: number
            maxY: number
            maxZ: number
          }
        }
        partNode.cadGeneration = {
          status: 'complete',
          generationMethod: 'parametric',
          stepFileKey: result.vaultFileId,
          boundingBox: result.boundingBox,
        }

        yield {
          type: 'llm_text',
          text: `Successfully regenerated parametric CAD for "${partNode.name}".`,
        }

        // Mark ancestor assemblies as stale
        if (artifacts.bom) {
          const affected = findAffectedAssemblies(
            tempId,
            artifacts.bom.rootAssembly,
          )
          if (affected.length > 0) {
            markAssembliesStale(artifacts.bom.rootAssembly, affected)
            yield* notifyStaleAssemblies(artifacts.bom.rootAssembly, affected)
          }
        }

        await DesignSessionService.updateArtifacts(session.id, artifacts)
        yield { type: 'artifact_update', artifacts: { bom: artifacts.bom } }
        return
      }

      if (current.status === 'failed') {
        partNode.cadGeneration = {
          status: 'failed',
          generationMethod: 'parametric',
          errorMessage: current.error ?? 'Parametric generation failed',
        }
        yield {
          type: 'llm_text',
          text: `Failed to regenerate "${partNode.name}": ${current.error}`,
        }
        await DesignSessionService.updateArtifacts(session.id, artifacts)
        yield { type: 'artifact_update', artifacts: { bom: artifacts.bom } }
        return
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    partNode.cadGeneration = {
      status: 'failed',
      generationMethod: 'parametric',
      errorMessage: 'Parametric generation timed out',
    }
    yield {
      type: 'llm_text',
      text: `Parametric generation timed out for "${partNode.name}"`,
    }
    await DesignSessionService.updateArtifacts(session.id, artifacts)
    yield { type: 'artifact_update', artifacts: { bom: artifacts.bom } }
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : 'Regeneration failed'
    partNode.cadGeneration = {
      status: 'failed',
      generationMethod: 'parametric',
      errorMessage: errMsg,
    }
    yield {
      type: 'llm_text',
      text: `Failed to regenerate "${partNode.name}": ${errMsg}`,
    }
    await DesignSessionService.updateArtifacts(session.id, artifacts)
    yield { type: 'artifact_update', artifacts: { bom: artifacts.bom } }
  }
}

/**
 * One usage row for a run, written only when an agent call actually resolved a
 * provider — which is also the signal that a request went out. These rows are
 * what `enforceMonthlyTokenBudget` sums, so an unwritten one is spend that
 * escapes the budget rather than merely missing telemetry.
 */
async function recordStageUsage(
  session: DesignSession,
  usage: UsageAccumulator,
  providerRef: ProviderRef,
  startedAt: number,
): Promise<void> {
  const resolved = providerRef.current
  if (!resolved) return
  const totals = usage.totals
  await recordLlmUsage({
    userId: session.userId,
    // The ai_chat_sessions row, not the design session — that is what
    // ai_usage_logs.session_id references.
    sessionId: session.aiChatSessionId,
    programId: session.programId,
    provider: resolved.provider,
    model: resolved.model,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    durationMs: Date.now() - startedAt,
  })
}

/** Collect leaf Manufacture parts from the BOM tree (for counting results). */
function collectLeafManufactureParts(node: BomNodeDraft): Array<BomNodeDraft> {
  const parts: Array<BomNodeDraft> = []
  function walk(n: BomNodeDraft) {
    if (n.isNew && n.partType === 'Manufacture' && n.children.length === 0) {
      parts.push(n)
    }
    for (const child of n.children) {
      walk(child)
    }
  }
  walk(node)
  return parts
}
