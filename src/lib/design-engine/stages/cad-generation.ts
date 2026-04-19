/**
 * CAD Generation Stage Processor
 *
 * Generates individual STEP files for each new Manufacture part
 * using Zoo's Text-to-CAD API. Runs after materialization, which
 * provides the tempId → itemId mapping needed for vault storage.
 */

import { DesignSessionService } from '../session-service'
import type { DesignSession } from '../session-service'
import type { BomNodeDraft, DesignArtifacts, StageEvent } from '../types'
import type { CadPromptContext } from '@/lib/cad-generation/types'
import { generateAllParts } from '@/lib/cad-generation/part-generator'
import { ZooClient } from '@/lib/cad-generation/zoo-client'
import { buildCadPrompt } from '@/lib/cad-generation/prompt-builder'
import {
  findAffectedAssemblies,
  markAssembliesStale,
  notifyStaleAssemblies,
} from '@/lib/cad-generation/cascade-recompose'

export async function* runCadGenerationStage(
  session: DesignSession,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  yield { type: 'stage_change', stage: 'cad_generation' }
  await DesignSessionService.updateStage(session.id, 'cad_generation')

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

  // Build tempId → itemId mapping from materialization result
  const tempIdToItemId = new Map<string, string>()
  for (const item of artifacts.materializationResult.createdItems) {
    tempIdToItemId.set(item.tempId, item.itemId)
  }

  try {
    // Dynamically import FileService to avoid pulling DB into client bundle
    const { FileService } = await import('@/lib/vault/services/FileService')

    const uploadFile = async (
      itemId: string,
      fileName: string,
      content: Buffer,
    ): Promise<string> => {
      const result = await FileService.uploadFile({
        itemId,
        file: content,
        metadata: {
          originalFileName: fileName,
          mimeType: 'application/step',
          size: content.length,
          description: `Auto-generated STEP file from design engine`,
        },
        uploadedBy: session.userId,
      })
      return result.id
    }

    // Resolve branchId from the materialized design's ECO-design relationship
    let branchId: string | undefined
    if (artifacts.materializationResult.ecoId) {
      try {
        const { db } = await import('@/lib/db')
        const { changeOrderDesigns } = await import('@/lib/db/schema/items')
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
        // Non-critical — parametric parts will fall back to Zoo
      }
    }

    // Run part generation, forwarding all events (checking abort between each)
    for await (const event of generateAllParts(artifacts.bom.rootAssembly, {
      tempIdToItemId,
      uploadFile,
      productDescription: artifacts.description,
      branchId,
      userId: session.userId,
    })) {
      if (signal?.aborted) break
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
      partsCompleted: cadLeaves.length,
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

  try {
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

    const zooClient = new ZooClient()

    const promptContext: CadPromptContext = {
      partName: partNode.name,
      partDescription: partNode.rationale || partNode.name,
      material: partNode.material,
      interfaces: (partNode.interfaces ?? []).map((i) => ({
        description: i.description,
        mateType: i.mateType,
        geometry: i.geometry,
        locationHint: i.locationHint,
      })),
      overallProductDescription: artifacts.description,
      additionalFeedback: feedback,
    }

    const prompt = buildCadPrompt(promptContext)
    const { requestId, stepContent } = await zooClient.generateAndWait(
      prompt,
      'step',
    )

    // Upload replacement file
    const { FileService } = await import('@/lib/vault/services/FileService')

    const fileName = `${partNode.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.step`
    const result = await FileService.uploadFile({
      itemId,
      file: stepContent,
      metadata: {
        originalFileName: fileName,
        mimeType: 'application/step',
        size: stepContent.length,
        description: `Regenerated STEP file${feedback ? ` — feedback: ${feedback}` : ''}`,
      },
      uploadedBy: session.userId,
    })

    partNode.cadGeneration = {
      status: 'complete',
      generationMethod: 'zoo',
      zooRequestId: requestId,
      stepFileKey: result.id,
      promptUsed: prompt,
    }

    yield {
      type: 'llm_text',
      text: `Successfully regenerated CAD for "${partNode.name}".`,
    }

    // Mark ancestor assemblies as stale
    const affected = findAffectedAssemblies(tempId, artifacts.bom.rootAssembly)
    if (affected.length > 0) {
      markAssembliesStale(artifacts.bom.rootAssembly, affected)
      yield* notifyStaleAssemblies(artifacts.bom.rootAssembly, affected)
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
      errorMessage: errMsg,
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
  }
}

function findNode(root: BomNodeDraft, tempId: string): BomNodeDraft | null {
  if (root.tempId === tempId) return root
  for (const child of root.children) {
    const found = findNode(child, tempId)
    if (found) return found
  }
  return null
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
      const { db } = await import('@/lib/db')
      const { changeOrderDesigns } = await import('@/lib/db/schema/items')
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

    const { JobService } = await import('@/lib/jobs/JobService')

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
