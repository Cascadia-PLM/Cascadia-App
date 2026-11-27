// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Part CAD Generator
 *
 * Orchestrates parallel generation of STEP files for new Manufacture parts.
 * Parts with a parametricSpec are dispatched to the CadQuery worker via
 * RabbitMQ for instant generation (~1s). Parts without a spec go to the
 * FreeCAD agent (`freecad-agent.ts`): the AI provider writes a FreeCAD script,
 * the FreeCAD worker runs it, and the model iterates on the report — usually
 * one to three attempts, tens of seconds to a few minutes each.
 */

import { generatePartWithFreecad } from './freecad-agent'
import { createProgressChannel } from './progress-channel'
import type { ProgressChannel } from './progress-channel'
import type {
  BomNodeDraft,
  CadGenerationState,
  StageEvent,
} from '@/design-engine/types'
import type {
  BoundingBox3D,
  CadGenerationResult,
  CadPromptContext,
} from './types'
import type { UsageAccumulator } from '@/ai/usage'

export interface PartGeneratorOptions {
  /** Max parts generated at once (each FreeCAD part is one agent run). */
  concurrency?: number
  /** Map from tempId to itemId (from materialization result) */
  tempIdToItemId: Map<string, string>
  /** Overall product description for context */
  productDescription?: string
  /** Branch the generated STEP files belong to */
  branchId?: string
  /** User the jobs are submitted as; required for every generation path */
  userId?: string
  /** Program whose AI provider and budget the agent resolves */
  programId?: string | null
  /** Cancels in-flight agent runs and job polling. */
  signal?: AbortSignal
  /**
   * Shared token accumulator. The stage owns it and writes one usage row for
   * the whole run — several parts generating in parallel are still one run.
   */
  usage?: UsageAccumulator
  /** Told which provider/model served the agent's calls. */
  onProviderResolved?: (resolved: {
    provider: string | null
    model: string | null
  }) => void
  /** Overrides the admin-configured attempt budget per part. */
  maxIterations?: number
  /** Overrides the admin-configured script timeout, in milliseconds. */
  scriptTimeoutMs?: number
}

/**
 * Collect all leaf "Manufacture" parts that need CAD generation.
 */
export function collectCadParts(rootNode: BomNodeDraft): {
  parts: Array<BomNodeDraft>
  parentMap: Map<string, BomNodeDraft>
  mechanismAssemblies: Array<BomNodeDraft>
  mechanismCoveredTempIds: Set<string>
} {
  const parts: Array<BomNodeDraft> = []
  const parentMap = new Map<string, BomNodeDraft>()
  const mechanismAssemblies: Array<BomNodeDraft> = []
  const mechanismCoveredTempIds = new Set<string>()

  function walk(node: BomNodeDraft, parent?: BomNodeDraft) {
    // Collect mechanism assemblies and track covered children
    if (node.mechanismTemplate) {
      mechanismAssemblies.push(node)
      for (const mapping of node.mechanismTemplate.partMapping) {
        mechanismCoveredTempIds.add(mapping.tempId)
      }
      if (parent) {
        parentMap.set(node.tempId, parent)
      }
    }

    // Generate CAD for new Manufacture parts (leaf parts without children,
    // or parts with children that also need their own geometry)
    if (
      node.isNew &&
      node.partType === 'Manufacture' &&
      node.children.length === 0
    ) {
      if (parent) {
        parentMap.set(node.tempId, parent)
      }
      parts.push(node)
    }

    for (const child of node.children) {
      walk(child, node)
    }
  }

  walk(rootNode)
  return { parts, parentMap, mechanismAssemblies, mechanismCoveredTempIds }
}

/** What the concurrency pool races: a finished part, or progress to relay. */
type Settled =
  { kind: 'result'; result: CadGenerationResult } | { kind: 'progress' }

/**
 * Generate STEP files for all eligible parts with concurrency control.
 */
export async function* generateAllParts(
  rootNode: BomNodeDraft,
  options: PartGeneratorOptions,
): AsyncGenerator<StageEvent> {
  const { parts, parentMap, mechanismAssemblies, mechanismCoveredTempIds } =
    collectCadParts(rootNode)
  const envConcurrency = process.env.CAD_GENERATION_CONCURRENCY
    ? Number(process.env.CAD_GENERATION_CONCURRENCY)
    : undefined
  const concurrency = Math.max(1, options.concurrency ?? envConcurrency ?? 3)

  const isComplete = (p: BomNodeDraft) => p.cadGeneration?.status === 'complete'
  const partsByTempId = new Map(parts.map((p) => [p.tempId, p]))

  // Filter out parts that are covered by mechanism templates, and — for
  // resume-idempotency — parts that already generated successfully (a
  // clarification pause or dropped connection must not re-generate them).
  const individualParts = parts.filter(
    (p) => !mechanismCoveredTempIds.has(p.tempId) && !isComplete(p),
  )
  const pendingMechanisms = mechanismAssemblies.filter((assembly) =>
    assembly.mechanismTemplate?.partMapping.some((m) => {
      const child = partsByTempId.get(m.tempId)
      return !child || !isComplete(child)
    }),
  )
  const alreadyComplete = parts.filter(isComplete).length
  const totalParts = parts.length

  if (totalParts === 0) {
    yield {
      type: 'llm_text',
      text: 'No new Manufacture parts found for CAD generation.',
    }
    return
  }

  if (individualParts.length === 0 && pendingMechanisms.length === 0) {
    yield {
      type: 'llm_text',
      text: 'All parts already have generated CAD — nothing to do.',
    }
    return
  }

  if (alreadyComplete > 0) {
    yield {
      type: 'llm_text',
      text: `Skipping ${alreadyComplete} part(s) that already generated successfully.`,
    }
  }

  // Progress state. Declared before Phase 1 so mechanism results have
  // something to report against, and seeded with the parts a previous run
  // already finished so a resume does not restart the count at zero.
  const state: CadGenerationState = {
    status: 'generating_parts',
    partsTotal: totalParts,
    partsCompleted: alreadyComplete,
    partsFailed: 0,
    assembliesTotal: 0,
    assembliesCompleted: 0,
    assembliesFailed: 0,
    startedAt: new Date().toISOString(),
  }

  yield {
    type: 'artifact_update',
    artifacts: { cadGenerationState: { ...state } },
  }

  // Phase 1: Process mechanism assemblies (each generates multiple parts)
  if (pendingMechanisms.length > 0) {
    yield {
      type: 'llm_text',
      text: `Generating ${pendingMechanisms.length} mechanism(s)...`,
    }

    for (const assembly of pendingMechanisms) {
      const mechResults = await generateMechanismParts(assembly, options)
      for (const [_role, result] of mechResults) {
        // Find the child node in the full parts list to update its status
        const matchingChild = parts.find((p) => p.tempId === result.tempId)
        if (matchingChild) updatePartStatus(matchingChild, result)
        if (!result.success) state.partsFailed++
      }
      state.partsCompleted = parts.filter(isComplete).length

      // One event per finished mechanism, so the stage writes its child
      // parts' statuses before the next mechanism job (up to two minutes)
      // starts. The outputs are already in the vault; an interruption in
      // between must not send them back through generation.
      yield {
        type: 'artifact_update',
        artifacts: { cadGenerationState: { ...state } },
      }
    }
  }

  // Phase 2: Process remaining individual parts (not covered by mechanisms)
  // under a concurrency pool. The pool races the in-flight parts against the
  // progress channel, so a part's per-attempt lines reach the client while
  // the part is still generating rather than after it finishes.
  const queue = [...individualParts]
  const pending = new Map<string, Promise<Settled>>()
  const progress = createProgressChannel()
  let partIndex = 0

  const start = (part: BomNodeDraft) => {
    const promise = part.parametricSpec
      ? generateParametricPart(part, options)
      : generateFreecadPart(part, options, parentMap, progress)
    pending.set(
      part.tempId,
      promise.then(
        (result): Settled => ({ kind: 'result', result }),
        (error: unknown): Settled => ({
          kind: 'result',
          result: {
            tempId: part.tempId,
            itemId: options.tempIdToItemId.get(part.tempId) ?? '',
            success: false,
            errorMessage:
              error instanceof Error ? error.message : 'Unknown error',
          },
        }),
      ),
    )
  }

  while (queue.length > 0 || pending.size > 0) {
    while (queue.length > 0 && pending.size < concurrency) {
      const next = queue.shift()
      if (next) start(next)
    }

    const settled = await Promise.race<Settled>([
      ...pending.values(),
      progress.wait().then((): Settled => ({ kind: 'progress' })),
    ])

    for (const text of progress.drain()) {
      yield { type: 'llm_text', text }
    }

    if (settled.kind !== 'result') continue

    const { result } = settled
    pending.delete(result.tempId)
    const matchingPart = partsByTempId.get(result.tempId)
    if (matchingPart) updatePartStatus(matchingPart, result)
    state.partsCompleted++
    if (!result.success) state.partsFailed++

    yield* emitPartResult(result, state, ++partIndex, totalParts)
  }

  state.status = state.partsFailed === state.partsTotal ? 'failed' : 'complete'
  state.completedAt = new Date().toISOString()

  yield {
    type: 'artifact_update',
    artifacts: { cadGenerationState: { ...state } },
  }
}

/**
 * Build the prompt context for a part from its BOM node and its neighbours.
 */
export function buildPartPromptContext(
  part: BomNodeDraft,
  parentNode: BomNodeDraft | undefined,
  productDescription?: string,
): CadPromptContext {
  const promptContext: CadPromptContext = {
    partName: part.name,
    partDescription: part.rationale || part.name,
    material: part.material,
    interfaces: (part.interfaces ?? []).map((i) => ({
      description: i.description,
      mateType: i.mateType,
      geometry: i.geometry,
      locationHint: i.locationHint,
    })),
    parentAssemblyName: parentNode?.name,
    parentAssemblyDescription: parentNode?.rationale,
    overallProductDescription: productDescription,
    manufacturingConstraints: part.manufacturingConstraints,
    cadGenerationHint: part.cadGenerationHint,
  }

  // Sibling context, for proportioning
  if (parentNode) {
    promptContext.siblingParts = parentNode.children
      .filter((c) => c.tempId !== part.tempId)
      .map((c) => ({
        name: c.name,
        description: c.rationale || c.name,
        boundingBox: c.cadGeneration?.boundingBox,
      }))
  }

  return promptContext
}

/**
 * Generate one part's STEP with the FreeCAD agent. Never rejects: every
 * outcome is a `CadGenerationResult`, which is how the pool and the stage's
 * counters stay consistent.
 */
async function generateFreecadPart(
  part: BomNodeDraft,
  options: PartGeneratorOptions,
  parentMap: Map<string, BomNodeDraft>,
  progress: ProgressChannel,
): Promise<CadGenerationResult> {
  const itemId = options.tempIdToItemId.get(part.tempId)
  if (!itemId) {
    return {
      tempId: part.tempId,
      itemId: '',
      success: false,
      generationMethod: 'freecad',
      errorMessage: `No materialized item found for tempId ${part.tempId}`,
    }
  }

  if (!options.userId) {
    return {
      tempId: part.tempId,
      itemId,
      success: false,
      generationMethod: 'freecad',
      errorMessage: 'userId required for FreeCAD generation',
    }
  }

  try {
    const result = await generatePartWithFreecad({
      promptContext: buildPartPromptContext(
        part,
        parentMap.get(part.tempId),
        options.productDescription,
      ),
      partName: part.name,
      userId: options.userId,
      itemId,
      branchId: options.branchId,
      programId: options.programId,
      maxIterations: options.maxIterations,
      scriptTimeoutMs: options.scriptTimeoutMs,
      signal: options.signal,
      usage: options.usage,
      onProviderResolved: options.onProviderResolved,
      onProgress: (event) => progress.push(`${part.name}: ${event.text}`),
    })

    if (!result.success) {
      return {
        tempId: part.tempId,
        itemId,
        success: false,
        generationMethod: 'freecad',
        errorMessage: result.errorMessage,
        iterations: result.iterations,
        script: result.lastScript,
      }
    }

    return {
      tempId: part.tempId,
      itemId,
      success: true,
      generationMethod: 'freecad',
      vaultFileId: result.vaultFileId,
      boundingBox: result.boundingBox,
      script: result.script,
      iterations: result.iterations,
    }
  } catch (error) {
    return {
      tempId: part.tempId,
      itemId,
      success: false,
      generationMethod: 'freecad',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Generate a STEP file for a part with a parametric spec via the CadQuery worker.
 * Submits a RabbitMQ job and polls until complete/failed.
 */
async function generateParametricPart(
  part: BomNodeDraft,
  options: PartGeneratorOptions,
): Promise<CadGenerationResult> {
  const itemId = options.tempIdToItemId.get(part.tempId)
  if (!itemId) {
    return {
      tempId: part.tempId,
      itemId: '',
      success: false,
      generationMethod: 'parametric',
      errorMessage: `No materialized item found for tempId ${part.tempId}`,
    }
  }

  if (!options.branchId || !options.userId) {
    return {
      tempId: part.tempId,
      itemId,
      success: false,
      generationMethod: 'parametric',
      errorMessage: 'branchId and userId required for parametric generation',
    }
  }

  try {
    const { JobService } = await import('@/jobs/JobService')

    const job = await JobService.submit(
      'generation.cad.parametric',
      {
        partTempId: part.tempId,
        partName: part.name,
        itemId,
        branchId: options.branchId,
        userId: options.userId,
        spec: part.parametricSpec,
      },
      options.userId,
      { priority: 'high', itemId },
    )

    // Poll for completion (parametric jobs typically finish in 1-2s)
    const maxWaitMs = 60_000
    const pollIntervalMs = 500
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      // The caller has gone. Without this the loop kept polling to its full
      // 60s budget after an abort — holding a concurrency slot, and keeping
      // the whole stage generator alive long past the request that started
      // it. Reported as a per-part failure, which is already how this
      // generator says "no geometry came out of this one".
      if (options.signal?.aborted) {
        return {
          tempId: part.tempId,
          itemId,
          success: false,
          generationMethod: 'parametric',
          errorMessage: 'Cancelled',
        }
      }

      const current = await JobService.get(job.id)
      if (!current) break

      if (current.status === 'completed' && current.result) {
        const result = current.result as {
          partTempId: string
          vaultFileId: string
          fileName: string
          generationTimeMs: number
          boundingBox?: BoundingBox3D
        }
        return {
          tempId: part.tempId,
          itemId,
          success: true,
          generationMethod: 'parametric',
          vaultFileId: result.vaultFileId,
          boundingBox: result.boundingBox,
        }
      }

      if (current.status === 'failed') {
        return {
          tempId: part.tempId,
          itemId,
          success: false,
          generationMethod: 'parametric',
          errorMessage: current.error ?? 'Parametric generation job failed',
        }
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    return {
      tempId: part.tempId,
      itemId,
      success: false,
      generationMethod: 'parametric',
      errorMessage: 'Parametric generation timed out',
    }
  } catch (error) {
    return {
      tempId: part.tempId,
      itemId,
      success: false,
      generationMethod: 'parametric',
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

/**
 * Generate STEP files for all parts in a mechanism template.
 * Submits a single mechanism job and maps results back to child nodes by role.
 */
async function generateMechanismParts(
  assembly: BomNodeDraft,
  options: PartGeneratorOptions,
): Promise<Map<string, CadGenerationResult>> {
  const results = new Map<string, CadGenerationResult>()
  const mt = assembly.mechanismTemplate
  if (!mt) return results

  // Build partMapping with itemIds from materialization
  const partMapping = mt.partMapping.map((m) => {
    const itemId = options.tempIdToItemId.get(m.tempId) ?? ''
    return { role: m.role, tempId: m.tempId, itemId }
  })

  // Check all itemIds resolved
  const missingItemId = partMapping.find((m) => !m.itemId)
  if (missingItemId) {
    for (const m of partMapping) {
      results.set(m.role, {
        tempId: m.tempId,
        itemId: m.itemId,
        success: false,
        generationMethod: 'mechanism',
        errorMessage: `No materialized item found for mechanism part (role: ${missingItemId.role})`,
      })
    }
    return results
  }

  if (!options.branchId || !options.userId) {
    for (const m of partMapping) {
      results.set(m.role, {
        tempId: m.tempId,
        itemId: m.itemId,
        success: false,
        generationMethod: 'mechanism',
        errorMessage: 'branchId and userId required for mechanism generation',
      })
    }
    return results
  }

  try {
    const { JobService } = await import('@/jobs/JobService')

    const job = await JobService.submit(
      'generation.cad.mechanism',
      {
        assemblyTempId: assembly.tempId,
        assemblyName: assembly.name,
        mechanismType: mt.mechanismType,
        parameters: mt.parameters,
        units: mt.units,
        partMapping,
        branchId: options.branchId,
        userId: options.userId,
      },
      options.userId,
      { priority: 'high' },
    )

    // Poll for completion (mechanism jobs may take longer than simple parametric)
    const maxWaitMs = 120_000
    const pollIntervalMs = 500
    const startTime = Date.now()

    while (Date.now() - startTime < maxWaitMs) {
      // Same as the parametric loop, with a 120s budget to burn through
      // instead of 60s: stop the moment the caller is gone.
      if (options.signal?.aborted) {
        for (const m of partMapping) {
          results.set(m.role, {
            tempId: m.tempId,
            itemId: m.itemId,
            success: false,
            generationMethod: 'mechanism',
            errorMessage: 'Cancelled',
          })
        }
        return results
      }

      const current = await JobService.get(job.id)
      if (!current) break

      if (current.status === 'completed' && current.result) {
        const mechResult = current.result as {
          assemblyTempId: string
          mechanismType: string
          generationTimeMs: number
          outputs: Record<
            string,
            {
              vaultFileId: string
              fileName: string
              boundingBox?: BoundingBox3D
            }
          >
          metadata: Record<string, unknown>
        }

        // Map each role output to its child node
        for (const mapping of partMapping) {
          const output = mechResult.outputs[mapping.role]
          if (output) {
            results.set(mapping.role, {
              tempId: mapping.tempId,
              itemId: mapping.itemId,
              success: true,
              generationMethod: 'mechanism',
              vaultFileId: output.vaultFileId,
              boundingBox: output.boundingBox,
            })
          } else {
            results.set(mapping.role, {
              tempId: mapping.tempId,
              itemId: mapping.itemId,
              success: false,
              generationMethod: 'mechanism',
              errorMessage: `Mechanism output missing for role: ${mapping.role}`,
            })
          }
        }
        return results
      }

      if (current.status === 'failed') {
        for (const m of partMapping) {
          results.set(m.role, {
            tempId: m.tempId,
            itemId: m.itemId,
            success: false,
            generationMethod: 'mechanism',
            errorMessage: current.error ?? 'Mechanism generation job failed',
          })
        }
        return results
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
    }

    // Timeout
    for (const m of partMapping) {
      results.set(m.role, {
        tempId: m.tempId,
        itemId: m.itemId,
        success: false,
        generationMethod: 'mechanism',
        errorMessage: 'Mechanism generation timed out',
      })
    }
    return results
  } catch (error) {
    for (const m of partMapping) {
      results.set(m.role, {
        tempId: m.tempId,
        itemId: m.itemId,
        success: false,
        generationMethod: 'mechanism',
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      })
    }
    return results
  }
}

function updatePartStatus(
  part: BomNodeDraft,
  result: CadGenerationResult,
): void {
  part.cadGeneration = {
    status: result.success ? 'complete' : 'failed',
    generationMethod: result.generationMethod,
    stepFileKey: result.vaultFileId,
    errorMessage: result.errorMessage,
    boundingBox: result.boundingBox,
    generationScript: result.script,
    iterations: result.iterations,
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- AsyncGenerator return type forces async
async function* emitPartResult(
  result: CadGenerationResult,
  state: CadGenerationState,
  current: number,
  total: number,
): AsyncGenerator<StageEvent> {
  const status = result.success ? 'generated' : 'failed'
  const attempts =
    result.iterations !== undefined
      ? ` (${result.iterations} attempt${result.iterations === 1 ? '' : 's'})`
      : ''
  yield {
    type: 'llm_text',
    text: `[${current}/${total}] Part CAD ${status}: ${result.tempId}${attempts}${result.errorMessage ? ` - ${result.errorMessage}` : ''}`,
  }

  yield {
    type: 'artifact_update',
    artifacts: { cadGenerationState: { ...state } },
  }
}
