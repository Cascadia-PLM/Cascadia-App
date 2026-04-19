// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Part CAD Generator
 *
 * Orchestrates parallel generation of STEP files for new Manufacture parts.
 * Parts with a parametricSpec are dispatched to the CadQuery worker via
 * RabbitMQ for instant generation (~1s). Parts without a spec fall through
 * to Zoo's Text-to-CAD API (~10min).
 */

import { ZooClient } from './zoo-client'
import { buildCadPrompt } from './prompt-builder'
import type {
  BomNodeDraft,
  CadGenerationState,
  StageEvent,
} from '@/lib/design-engine/types'
import type {
  BoundingBox3D,
  CadGenerationResult,
  CadPromptContext,
} from './types'

interface PartGeneratorOptions {
  /** Max concurrent Zoo API calls */
  concurrency?: number
  /** Function to upload STEP file to vault */
  uploadFile: (
    itemId: string,
    fileName: string,
    content: Buffer,
  ) => Promise<string>
  /** Map from tempId to itemId (from materialization result) */
  tempIdToItemId: Map<string, string>
  /** Overall product description for context */
  productDescription?: string
  /** Branch ID for parametric job submissions */
  branchId?: string
  /** User ID for parametric job submissions */
  userId?: string
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

/**
 * Generate STEP files for all eligible parts with concurrency control.
 */
export async function* generateAllParts(
  rootNode: BomNodeDraft,
  options: PartGeneratorOptions,
): AsyncGenerator<StageEvent> {
  const { parts, parentMap, mechanismAssemblies, mechanismCoveredTempIds } =
    collectCadParts(rootNode)
  const envConcurrency = process.env.ZOO_TEXT_TO_CAD_CONCURRENCY
    ? Number(process.env.ZOO_TEXT_TO_CAD_CONCURRENCY)
    : undefined
  const concurrency = options.concurrency ?? envConcurrency ?? 3

  // Filter out parts that are covered by mechanism templates
  const individualParts = parts.filter(
    (p) => !mechanismCoveredTempIds.has(p.tempId),
  )
  const totalParts = individualParts.length + mechanismCoveredTempIds.size

  if (totalParts === 0) {
    yield {
      type: 'llm_text',
      text: 'No new Manufacture parts found for CAD generation.',
    }
    return
  }

  // Phase 1: Process mechanism assemblies (each generates multiple parts)
  if (mechanismAssemblies.length > 0) {
    yield {
      type: 'llm_text',
      text: `Generating ${mechanismAssemblies.length} mechanism(s) (${mechanismCoveredTempIds.size} parts)...`,
    }

    for (const assembly of mechanismAssemblies) {
      const mechResults = await generateMechanismParts(assembly, options)
      for (const [_role, result] of mechResults) {
        // Find the child node in the full parts list to update its status
        const matchingChild = parts.find((p) => p.tempId === result.tempId)
        if (matchingChild) updatePartStatus(matchingChild, result)
      }
    }
  }

  // Phase 2: Process remaining individual parts (not covered by mechanisms)
  const remainingParts = individualParts

  const state: CadGenerationState = {
    status: 'generating_parts',
    partsTotal: totalParts,
    partsCompleted: 0,
    partsFailed: 0,
    assembliesTotal: 0,
    assembliesCompleted: 0,
    assembliesFailed: 0,
    startedAt: new Date().toISOString(),
  }

  yield {
    type: 'artifact_update',
    artifacts: { cadGenerationState: state },
  }

  const zooClient = new ZooClient()
  const results: Array<CadGenerationResult> = []

  // Process parts with concurrency limit using a Map keyed by tempId
  // so we can correctly identify which promise settled.
  const pending = new Map<string, Promise<CadGenerationResult>>()
  let partIndex = 0

  // Account for mechanism parts already generated in Phase 1
  state.partsCompleted = mechanismCoveredTempIds.size

  for (const part of remainingParts) {
    const promise = part.parametricSpec
      ? generateParametricPart(part, options)
      : generateSinglePart(part, rootNode, zooClient, options, parentMap)
    pending.set(part.tempId, promise)

    // When we hit the concurrency limit, wait for one to finish
    if (pending.size >= concurrency) {
      const result = await Promise.race(pending.values())
      pending.delete(result.tempId)

      results.push(result)
      const matchingPart = remainingParts.find(
        (p) => p.tempId === result.tempId,
      )
      if (matchingPart) updatePartStatus(matchingPart, result)
      state.partsCompleted++
      if (!result.success) state.partsFailed++

      yield* emitPartResult(result, state, ++partIndex, totalParts)
    }
  }

  // Wait for remaining promises
  const remainingPromises = await Promise.allSettled(pending.values())
  for (const settled of remainingPromises) {
    partIndex++
    if (settled.status === 'fulfilled') {
      const result = settled.value
      results.push(result)
      const matchingPart = remainingParts.find(
        (p) => p.tempId === result.tempId,
      )
      if (matchingPart) updatePartStatus(matchingPart, result)
      state.partsCompleted++
      if (!result.success) state.partsFailed++

      yield* emitPartResult(result, state, partIndex, totalParts)
    } else {
      state.partsCompleted++
      state.partsFailed++
      yield {
        type: 'artifact_update',
        artifacts: { cadGenerationState: { ...state } },
      }
    }
  }

  state.status = state.partsFailed === state.partsTotal ? 'failed' : 'complete'
  state.completedAt = new Date().toISOString()

  yield {
    type: 'artifact_update',
    artifacts: { cadGenerationState: { ...state } },
  }
}

async function generateSinglePart(
  part: BomNodeDraft,
  _rootNode: BomNodeDraft,
  zooClient: ZooClient,
  options: PartGeneratorOptions,
  parentMap: Map<string, BomNodeDraft>,
): Promise<CadGenerationResult> {
  const itemId = options.tempIdToItemId.get(part.tempId)
  if (!itemId) {
    return {
      tempId: part.tempId,
      itemId: '',
      success: false,
      errorMessage: `No materialized item found for tempId ${part.tempId}`,
    }
  }

  try {
    // Build prompt from part context
    const parentNode = parentMap.get(part.tempId)

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
      overallProductDescription: options.productDescription,
      manufacturingConstraints: part.manufacturingConstraints,
      cadGenerationHint: part.cadGenerationHint,
    }

    // Add sibling context
    if (parentNode) {
      promptContext.siblingParts = parentNode.children
        .filter((c) => c.tempId !== part.tempId)
        .map((c) => ({
          name: c.name,
          description: c.rationale || c.name,
          boundingBox: c.cadGeneration?.boundingBox as
            | BoundingBox3D
            | undefined,
        }))
    }

    const prompt = buildCadPrompt(promptContext)

    // Call Zoo API
    const { requestId, stepContent } = await zooClient.generateAndWait(
      prompt,
      'step',
    )

    // Upload to vault
    const fileName = `${part.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.step`
    const vaultFileId = await options.uploadFile(itemId, fileName, stepContent)

    return {
      tempId: part.tempId,
      itemId,
      success: true,
      generationMethod: 'zoo' as const,
      stepFileContent: stepContent,
      vaultFileId,
      zooRequestId: requestId,
    }
  } catch (error) {
    return {
      tempId: part.tempId,
      itemId,
      success: false,
      generationMethod: 'zoo' as const,
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
    const { JobService } = await import('@/lib/jobs/JobService')

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
    const { JobService } = await import('@/lib/jobs/JobService')

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
    zooRequestId: result.zooRequestId,
    stepFileKey: result.vaultFileId,
    errorMessage: result.errorMessage,
    boundingBox: result.boundingBox,
  }
}

async function* emitPartResult(
  result: CadGenerationResult,
  state: CadGenerationState,
  current: number,
  total: number,
): AsyncGenerator<StageEvent> {
  const status = result.success ? 'generated' : 'failed'
  yield {
    type: 'llm_text',
    text: `[${current}/${total}] Part CAD ${status}: ${result.tempId}${result.errorMessage ? ` - ${result.errorMessage}` : ''}`,
  }

  yield {
    type: 'artifact_update',
    artifacts: { cadGenerationState: { ...state } },
  }
}
