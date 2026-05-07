/**
 * Assembly Composition Stage Processor
 *
 * Composes assemblies bottom-up: for each assembly node where all children
 * have STEP files, generates an assembly plan via LLM, produces KCL code,
 * and stores the assembled STEP file in the vault.
 *
 * Multi-level assemblies are processed in topological order (leaves first).
 */

import { DesignSessionService } from '../session-service'
import type { DesignSession } from '../session-service'
import type { DesignArtifacts, StageEvent } from '../types'
import type { BoundingBox3D } from '@/lib/cad-generation/types'
import { AssemblyPlanner } from '@/lib/cad-generation/assembly-planner'
import {
  computeAssemblyOrder,
  getUnreadyChildren,
  hasComposableGeometry,
  isAssemblyReady,
} from '@/lib/cad-generation/assembly-order'
import {
  validateAssemblyPlan,
  validateAssemblyReadiness,
} from '@/lib/cad-generation/assembly-validator'
import { generateKclProject } from '@/lib/cad-generation/kcl-generator'
import { computeExposedInterfaces } from '@/lib/cad-generation/interface-propagation'

export async function* runAssemblyCompositionStage(
  session: DesignSession,
  signal?: AbortSignal,
): AsyncGenerator<StageEvent> {
  yield { type: 'stage_change', stage: 'assembly_composition' }
  await DesignSessionService.updateStage(session.id, 'assembly_composition')

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

    yield {
      type: 'artifact_update',
      artifacts: { cadGenerationState: artifacts.cadGenerationState },
    }

    let completed = 0
    let failed = 0

    for (const assemblyNode of assemblyOrder) {
      if (signal?.aborted) break

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
            boundingBox: child.cadGeneration?.boundingBox as
              | BoundingBox3D
              | undefined,
            interfaces: (child.interfaces ?? []).map((i) => ({
              id: i.id,
              description: i.description,
              mateType: i.mateType,
              locationHint: i.locationHint,
              geometry: i.geometry,
            })),
          }))

        // Plan assembly via LLM
        const plan = await AssemblyPlanner.planAssembly(
          assemblyNode,
          childData,
          artifacts.description,
          session.programId,
        )

        // Validate the plan
        const childBoundingBoxes = new Map<string, BoundingBox3D>()
        for (const child of assemblyNode.children) {
          if (child.cadGeneration?.boundingBox) {
            childBoundingBoxes.set(
              child.tempId,
              child.cadGeneration.boundingBox,
            )
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

        // Generate KCL project
        assemblyNode.assemblyComposition = {
          status: 'rendering',
          assemblyPlan: JSON.stringify(plan),
          kclProjectRef: plan.kclCode,
        }

        const kclProject = generateKclProject(plan)

        yield {
          type: 'llm_text',
          text: `Generated KCL project for "${assemblyNode.name}" (${kclProject.files.length} file(s)). Assembly rendering via external engine would happen here.`,
        }

        // Compute exposed interfaces for parent-level use
        const exposed = computeExposedInterfaces(assemblyNode)
        if (exposed.length > 0) {
          yield {
            type: 'llm_text',
            text: `Assembly "${assemblyNode.name}" exposes ${exposed.length} interface(s) for parent assembly.`,
          }
        }

        // KCL code generated but no STEP file produced — requires Zoo Modeling API
        // or local KittyCAD engine to render KCL to STEP. Until then, multi-level
        // assembly composition cannot find sub-assembly geometry.
        assemblyNode.assemblyComposition = {
          status: 'code_only',
          assemblyPlan: JSON.stringify(plan),
          kclProjectRef: plan.kclCode,
        }

        completed++
      } catch (error) {
        const errMsg =
          error instanceof Error ? error.message : 'Assembly composition failed'
        yield {
          type: 'llm_text',
          text: `Failed to compose "${assemblyNode.name}": ${errMsg}`,
        }
        assemblyNode.assemblyComposition = {
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
  }
}
