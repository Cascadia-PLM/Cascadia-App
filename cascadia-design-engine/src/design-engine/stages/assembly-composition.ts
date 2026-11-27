// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Assembly Composition Stage Processor
 *
 * Composes assemblies bottom-up: for each assembly node where all children
 * have STEP files, generates an assembly plan via LLM, serializes it to a
 * FreeCAD assembly script (the plan's portable record), renders the composed
 * STEP via the CadQuery/OCCT worker (generation.cad.assemble), and stores the
 * assembled STEP file in the vault.
 *
 * Multi-level assemblies are processed in topological order (leaves first);
 * a composed sub-assembly's STEP + bounding box feed its parent's planning.
 */

import { DesignSessionService } from '../session-service'
import { unresolvedComments } from '../types'
import type { DesignSession } from '../session-service'
import type { DesignArtifacts, StageEvent } from '../types'
import type { BoundingBox3D } from '@/cad-generation/types'
import type { AssemblyClarificationRequest } from '@/cad-generation/assembly-planner'
import { AssemblyPlanner } from '@/cad-generation/assembly-planner'
import {
  computeAssemblyOrder,
  getUnreadyChildren,
  hasComposableGeometry,
  isAssemblyReady,
} from '@/cad-generation/assembly-order'
import {
  validateAssemblyPlan,
  validateAssemblyReadiness,
} from '@/cad-generation/assembly-validator'
import { generateAssemblyScript } from '@/cad-generation/assembly-script'
import { computeExposedInterfaces } from '@/cad-generation/interface-propagation'
import { renderAssemblyStep } from '@/cad-generation/assembly-render'
import { UsageAccumulator, recordLlmUsage } from '@/ai/usage'

export async function* runAssemblyCompositionStage(
  session: DesignSession,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  const isResuming = session.stage === 'assembly_composition'
  if (!isResuming) {
    yield { type: 'stage_change', stage: 'assembly_composition' }
    await DesignSessionService.updateStage(session.id, 'assembly_composition')
  }

  const artifacts: DesignArtifacts = session.artifacts ?? {
    description: '',
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }

  if (!artifacts.bom) {
    yield { type: 'error', message: 'No BOM found for assembly composition' }
    return
  }

  if (!artifacts.materializationResult) {
    yield {
      type: 'error',
      message: 'Materialization result not found.',
    }
    return
  }

  const rootAssembly = artifacts.bom.rootAssembly

  // tempId → itemId from materialization, for attaching assembly STEP files
  const tempIdToItemId = new Map<string, string>()
  for (const item of artifacts.materializationResult.createdItems) {
    tempIdToItemId.set(item.tempId, item.itemId)
  }

  // Resolve branchId from the materialized design's ECO-design relationship
  // (assembly STEP files are written into the ECO branch, like part CAD).
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
      // Non-critical — assemblies fall back to script-only below
    }
  }

  // One accumulator for the whole run, as the BOM stage does: the planner is
  // called once per assembly node, but a stage run is one *run* however many
  // requests it takes, and a row per node would multiply-count it. The planner
  // only feeds this; the single row is written in the finally below.
  const usage = new UsageAccumulator()
  const startedAt = Date.now()
  // Null until a planner call actually resolved a provider — which is also the
  // signal that a request went out. A run that composes nothing (no assemblies,
  // every node already complete on a resume, all skipped for want of geometry)
  // never reaches the planner, and a usage row for it would claim an LLM call
  // that never happened. Object wrapper because the planner sets it from a
  // callback, which TS's flow analysis does not see.
  const usageProviderRef: {
    current: { provider: string | null; model: string | null } | null
  } = { current: null }

  try {
    // Compute bottom-up processing order
    const assemblyOrder = computeAssemblyOrder(rootAssembly)

    if (assemblyOrder.length === 0) {
      yield {
        type: 'llm_text',
        text: 'No assemblies found to compose.',
      }
      yield { type: 'stage_change', stage: 'assembly_review' }
      await DesignSessionService.updateStage(session.id, 'assembly_review')
      return
    }

    // Update state
    if (artifacts.cadGenerationState) {
      artifacts.cadGenerationState.status = 'assembling'
      artifacts.cadGenerationState.assembliesTotal = assemblyOrder.length
      artifacts.cadGenerationState.assembliesCompleted = 0
      artifacts.cadGenerationState.assembliesFailed = 0
    }

    // Persisted here, like every other artifact_update this generator
    // yields: the SSE route no longer writes artifacts on the stream's
    // behalf, so an event without its own persist would be display-only
    // state that a reconnect loses.
    await DesignSessionService.updateArtifacts(session.id, artifacts)

    yield {
      type: 'artifact_update',
      artifacts: { cadGenerationState: artifacts.cadGenerationState },
    }

    let completed = 0
    let failed = 0

    for (const assemblyNode of assemblyOrder) {
      if (signal?.aborted) break

      // Resume-idempotent: skip assemblies that already composed (a
      // clarification pause must not redo finished work). Legacy
      // 'code_only' nodes are NOT skipped — re-running now renders the
      // geometry they never got.
      const priorStatus = assemblyNode.assemblyComposition?.status
      if (priorStatus === 'complete') {
        completed++
        continue
      }

      // Check if any children have geometry to compose
      if (!hasComposableGeometry(assemblyNode)) {
        yield {
          type: 'llm_text',
          text: `Skipping assembly "${assemblyNode.name}" — no children have STEP geometry (e.g. all Purchase parts).`,
        }
        // Not a failure — this assembly simply has no physical geometry
        assemblyNode.assemblyComposition = {
          status: 'complete',
          errorMessage: 'No composable geometry — non-physical assembly',
        }
        completed++
        continue
      }

      // Check readiness (all Manufacture parts must have CAD complete)
      if (!isAssemblyReady(assemblyNode)) {
        const unready = getUnreadyChildren(assemblyNode)
        yield {
          type: 'llm_text',
          text: `Skipping assembly "${assemblyNode.name}" — children not ready: ${unready.join(', ')}`,
        }
        failed++
        assemblyNode.assemblyComposition = {
          status: 'failed',
          errorMessage: `Children not ready: ${unready.join(', ')}`,
        }
        continue
      }

      // Validate readiness
      const readiness = validateAssemblyReadiness(assemblyNode)
      if (!readiness.valid) {
        const errors = readiness.issues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message)
          .join('; ')
        yield {
          type: 'llm_text',
          text: `Cannot compose "${assemblyNode.name}": ${errors}`,
        }
        failed++
        assemblyNode.assemblyComposition = {
          status: 'failed',
          errorMessage: errors,
        }
        continue
      }

      yield {
        type: 'llm_text',
        text: `Planning assembly: ${assemblyNode.name}...`,
      }

      assemblyNode.assemblyComposition = { status: 'planning' }

      try {
        // Build child data for the planner (only children with STEP files)
        const childData = assemblyNode.children
          .filter((child) => {
            const stepKey =
              child.cadGeneration?.stepFileKey ??
              child.assemblyComposition?.assemblyStepFileKey
            return !!stepKey
          })
          .map((child) => ({
            tempId: child.tempId,
            name: child.name,
            stepFileKey:
              child.cadGeneration?.stepFileKey ??
              child.assemblyComposition?.assemblyStepFileKey ??
              '',
            // Sub-assemblies carry their bounds on assemblyComposition
            boundingBox:
              child.cadGeneration?.boundingBox ??
              child.assemblyComposition?.boundingBox,
            interfaces: (child.interfaces ?? []).map((i) => ({
              id: i.id,
              description: i.description,
              mateType: i.mateType,
              locationHint: i.locationHint,
              geometry: i.geometry,
            })),
          }))

        // Plan assembly via LLM, folding in unresolved comments on this node
        // and any clarifications already answered for this stage.
        const assemblyNotes = unresolvedComments(
          artifacts.itemComments,
          'bom_node',
          assemblyNode.tempId,
        ).map((c) => c.text)
        const priorClarifications = artifacts.clarifications
          .filter((c) => c.stage === 'assembly_composition')
          .map((c) => ({ question: c.question, answer: c.answer }))

        let clarificationRequest: AssemblyClarificationRequest | null = null
        const plan = await AssemblyPlanner.planAssembly(
          assemblyNode,
          childData,
          artifacts.description,
          session.programId,
          {
            userNotes: assemblyNotes.length > 0 ? assemblyNotes : undefined,
            priorClarifications:
              priorClarifications.length > 0 ? priorClarifications : undefined,
            onClarification: (request) => {
              clarificationRequest = request
            },
            usage,
            onProviderResolved: (resolved) => {
              usageProviderRef.current = resolved
            },
            signal,
          },
        )

        // The planner asked the user instead of planning: pause the stage.
        // On answer_clarification the stage re-runs, skips completed
        // assemblies, and re-plans this node with the answer in context.
        if (!plan) {
          const request =
            clarificationRequest as AssemblyClarificationRequest | null
          if (!request) {
            throw new Error('Assembly planner returned no plan')
          }
          assemblyNode.assemblyComposition = { status: 'pending' }
          artifacts.pendingClarificationId = request.questionId
          artifacts.pendingClarification = {
            id: request.questionId,
            question: request.question,
            options: request.options,
            multiSelect: request.multiSelect,
            context: {
              stage: 'assembly_composition',
              nodeTempId: assemblyNode.tempId,
              nodeName: assemblyNode.name,
            },
          }
          await DesignSessionService.updateArtifacts(session.id, artifacts)

          yield {
            type: 'clarification_needed',
            questionId: request.questionId,
            question: request.question,
            options: request.options,
            multiSelect: request.multiSelect,
          }
          yield { type: 'paused', reason: 'Waiting for your answer...' }
          return
        }

        // Validate the plan
        const childBoundingBoxes = new Map<string, BoundingBox3D>()
        for (const child of assemblyNode.children) {
          const bb =
            child.cadGeneration?.boundingBox ??
            child.assemblyComposition?.boundingBox
          if (bb) {
            childBoundingBoxes.set(child.tempId, bb)
          }
        }

        const planValidation = validateAssemblyPlan(plan, childBoundingBoxes)

        if (planValidation.issues.length > 0) {
          const warnings = planValidation.issues
            .map((i) => `[${i.severity}] ${i.message}`)
            .join('; ')
          yield {
            type: 'llm_text',
            text: `Assembly "${assemblyNode.name}" plan warnings: ${warnings}`,
          }
        }

        // Serialize the plan to a FreeCAD script — the human-readable record
        // of the composition, kept beside the JSON plan on the node.
        const script = generateAssemblyScript(plan, assemblyNode.name)

        assemblyNode.assemblyComposition = {
          status: 'rendering',
          assemblyPlan: JSON.stringify(plan),
          assemblyScript: script.source,
        }

        yield {
          type: 'llm_text',
          text: `Generated FreeCAD assembly script for "${assemblyNode.name}" (${plan.placements.length} placement(s)).`,
        }

        // Compute exposed interfaces for parent-level use
        const exposed = computeExposedInterfaces(assemblyNode)
        if (exposed.length > 0) {
          yield {
            type: 'llm_text',
            text: `Assembly "${assemblyNode.name}" exposes ${exposed.length} interface(s) for parent assembly.`,
          }
        }

        // Render the composed STEP via the CadQuery/OCCT worker. Without a
        // materialized item + branch there is nowhere to attach the file, so
        // fall back to the script-only result rather than failing the node.
        const assemblyItemId =
          tempIdToItemId.get(assemblyNode.tempId) ?? assemblyNode.existingItemId
        if (!assemblyItemId || !branchId) {
          assemblyNode.assemblyComposition = {
            status: 'code_only',
            assemblyPlan: JSON.stringify(plan),
            assemblyScript: script.source,
          }
          yield {
            type: 'llm_text',
            text: `No materialized item or branch for "${assemblyNode.name}" — keeping the plan and assembly script only, no STEP rendered.`,
          }
          completed++
        } else {
          yield {
            type: 'llm_text',
            text: `Rendering assembly "${assemblyNode.name}" (${childData.length} children)...`,
          }

          const rendered = await renderAssemblyStep({
            plan,
            assemblyName: assemblyNode.name,
            children: childData.map((c) => ({
              tempId: c.tempId,
              name: c.name,
              stepFileKey: c.stepFileKey,
            })),
            itemId: assemblyItemId,
            branchId,
            userId: session.userId,
            signal,
          })

          assemblyNode.assemblyComposition = {
            status: 'complete',
            assemblyPlan: JSON.stringify(plan),
            assemblyScript: script.source,
            assemblyStepFileKey: rendered.vaultFileId,
            boundingBox: rendered.boundingBox,
          }

          yield {
            type: 'llm_text',
            text: `Assembly "${assemblyNode.name}" composed → ${rendered.fileName}.`,
          }
          completed++
        }
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : 'Assembly composition failed'
        yield {
          type: 'llm_text',
          text: `Failed to compose "${assemblyNode.name}": ${errMsg}`,
        }
        // Preserve any plan/script captured before the failure
        assemblyNode.assemblyComposition = {
          ...assemblyNode.assemblyComposition,
          status: 'failed',
          errorMessage: errMsg,
        }
        failed++
      }

      // Update progress
      if (artifacts.cadGenerationState) {
        artifacts.cadGenerationState.assembliesCompleted = completed + failed
        artifacts.cadGenerationState.assembliesFailed = failed
      }

      yield {
        type: 'artifact_update',
        artifacts: {
          bom: artifacts.bom,
          cadGenerationState: artifacts.cadGenerationState,
        },
      }

      await DesignSessionService.updateArtifacts(session.id, artifacts)
    }

    // Finalize
    if (artifacts.cadGenerationState) {
      artifacts.cadGenerationState.status =
        failed === assemblyOrder.length ? 'failed' : 'complete'
      artifacts.cadGenerationState.completedAt = new Date().toISOString()
    }

    // The final status also persists itself — this was the second event
    // (with the 'assembling' transition above) that only the deleted route
    // write used to save.
    await DesignSessionService.updateArtifacts(session.id, artifacts)

    yield {
      type: 'artifact_update',
      artifacts: { cadGenerationState: artifacts.cadGenerationState },
    }

    yield { type: 'stage_change', stage: 'assembly_review' }
    await DesignSessionService.updateStage(session.id, 'assembly_review')

    yield {
      type: 'stage_complete',
      stage: 'assembly_review',
      summary: `Assembly composition complete: ${completed}/${assemblyOrder.length} assemblies composed${failed > 0 ? `, ${failed} failed` : ''}.`,
    }
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Assembly composition stage failed'
    yield { type: 'error', message }
    await DesignSessionService.updateStatus(session.id, 'failed', message)
  } finally {
    // One row for the whole run, whatever ended it — a run that died mid-plan
    // still spent the tokens it spent, and these rows are what
    // `enforceMonthlyTokenBudget` sums, so an unwritten one is spend that
    // escapes the budget rather than merely missing telemetry.
    const resolved = usageProviderRef.current
    if (resolved) {
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
  }
}
