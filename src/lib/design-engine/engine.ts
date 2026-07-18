// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Collaborative Design Engine
 *
 * Orchestrates the human-in-the-loop design workflow:
 * description -> requirements -> BOM structure -> materialization
 *
 * Each stage uses LLM-powered analysis with streaming output,
 * tool calls for searching existing PLM data, and structured
 * artifact generation that the user reviews before proceeding.
 */

import { DesignSessionService } from './session-service'
import { DesignSnapshotService } from './snapshot-service'
import { effectiveReviewStatus, stageIndex } from './types'
import { runToolsetEstablishmentStage } from './stages/toolset-establishment'
import { runRequirementsStage } from './stages/requirements'
import { runBomStage } from './stages/bom'
import { runCadGenerationStage } from './stages/cad-generation'
import { runAssemblyCompositionStage } from './stages/assembly-composition'
import { MaterializationService } from './materialize'
import type {
  BomNodeDraft,
  DesignArtifacts,
  DesignEngine,
  DesignSessionContext,
  DesignSessionStage,
  LlmHistoryEntry,
  MaterializationResult,
  ReopenableStage,
  RequirementEdit,
  StageEvent,
} from './types'
import { NotFoundError, ValidationError } from '@/lib/errors'

/**
 * Count items still awaiting review for the gate being confirmed.
 * Only the requirements and BOM gates track per-item review state.
 * The BOM root node is skipped — confirming the gate approves the container.
 */
function countUnresolvedItems(
  artifacts: DesignArtifacts,
  stage: 'toolset' | 'requirements' | 'bom' | 'cad' | 'assembly',
): number {
  if (stage === 'requirements') {
    return artifacts.requirements.filter(
      (r) => effectiveReviewStatus(r) === 'proposed',
    ).length
  }
  if (stage === 'bom' && artifacts.bom) {
    let unresolved = 0
    const walk = (node: BomNodeDraft, isRoot: boolean) => {
      if (!isRoot && effectiveReviewStatus(node) === 'proposed') unresolved++
      for (const child of node.children) walk(child, false)
    }
    walk(artifacts.bom.rootAssembly, true)
    return unresolved
  }
  return 0
}

export class CollaborativeDesignEngine implements DesignEngine {
  /**
   * Wraps a stage generator to capture LLM history and persist it after the stage completes.
   */
  private async *wrapWithHistoryCapture(
    sessionId: string,
    generator: AsyncIterable<StageEvent>,
  ): AsyncIterable<StageEvent> {
    const session = await DesignSessionService.getById(sessionId)
    const history: Array<LlmHistoryEntry> = session?.llmHistory ?? []
    let currentAssistantText = ''

    try {
      for await (const event of generator) {
        if (event.type === 'llm_text') {
          currentAssistantText += event.text
        } else if (event.type === 'tool_call') {
          // Flush accumulated assistant text before tool call
          if (currentAssistantText) {
            history.push({ role: 'assistant', content: currentAssistantText })
            currentAssistantText = ''
          }
          history.push({
            role: 'tool',
            content: JSON.stringify({
              toolName: event.toolName,
              args: event.args,
            }),
          })
        } else if (event.type === 'tool_result') {
          history.push({
            role: 'tool',
            content: JSON.stringify({
              toolName: event.toolName,
              result: event.result,
            }),
          })
        }
        yield event
      }
    } finally {
      // Flush any remaining assistant text
      if (currentAssistantText) {
        history.push({ role: 'assistant', content: currentAssistantText })
      }
      await DesignSessionService.saveLlmHistory(sessionId, history)
    }
  }

  async createSession(
    context: DesignSessionContext,
  ): Promise<{ sessionId: string }> {
    const session = await DesignSessionService.create(context.userId, {
      description: context.description,
      programId: context.programId,
      designId: context.designId,
      aiChatSessionId: context.aiChatSessionId,
    })
    return { sessionId: session.id }
  }

  async *runToolsetEstablishmentStage(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<StageEvent> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    yield* this.wrapWithHistoryCapture(
      sessionId,
      runToolsetEstablishmentStage(session, signal),
    )
  }

  async *runRequirementsStage(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<StageEvent> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    yield* this.wrapWithHistoryCapture(
      sessionId,
      runRequirementsStage(session, signal),
    )
  }

  async *runBomStage(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<StageEvent> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    yield* this.wrapWithHistoryCapture(sessionId, runBomStage(session, signal))
  }

  async *runCadGenerationStage(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<StageEvent> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    yield* this.wrapWithHistoryCapture(
      sessionId,
      runCadGenerationStage(session, signal),
    )
  }

  async *runAssemblyCompositionStage(
    sessionId: string,
    signal?: AbortSignal,
  ): AsyncIterable<StageEvent> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    yield* this.wrapWithHistoryCapture(
      sessionId,
      runAssemblyCompositionStage(session, signal),
    )
  }

  async *regeneratePart(
    sessionId: string,
    tempId: string,
    feedback?: string,
    signal?: AbortSignal,
  ): AsyncIterable<StageEvent> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    // Import dynamically to avoid circular dependencies
    const { regeneratePartCad } = await import('./stages/cad-generation')
    yield* this.wrapWithHistoryCapture(
      sessionId,
      regeneratePartCad(session, tempId, feedback, signal),
    )
  }

  async pause(sessionId: string): Promise<void> {
    await DesignSessionService.updateStatus(sessionId, 'paused')
  }

  async updateDescription(
    sessionId: string,
    description: string,
  ): Promise<void> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const artifacts = session.artifacts ?? {
      description: '',
      requirements: [],
      bom: null,
      clarifications: [],
      userMessages: [],
    }
    artifacts.description = description

    await DesignSessionService.updateArtifacts(sessionId, artifacts)
  }

  async updateRequirements(
    sessionId: string,
    edits: Array<RequirementEdit>,
  ): Promise<void> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    const artifacts = session.artifacts ?? {
      description: '',
      requirements: [],
      bom: null,
      clarifications: [],
      userMessages: [],
    }

    for (const edit of edits) {
      if (edit.action === 'add' && edit.data) {
        artifacts.requirements.push({
          tempId: crypto.randomUUID(),
          name: edit.data.name ?? '',
          description: edit.data.description ?? '',
          requirementType: edit.data.requirementType ?? 'Functional',
          priority: edit.data.priority ?? 'medium',
          verificationMethod: edit.data.verificationMethod ?? 'Analysis',
          rationale: edit.data.rationale ?? '',
          confidence: edit.data.confidence ?? 1,
          source: 'user',
        })
      } else if (edit.action === 'update' && edit.tempId && edit.data) {
        const idx = artifacts.requirements.findIndex(
          (r) => r.tempId === edit.tempId,
        )
        const existingRequirement = artifacts.requirements[idx]
        if (existingRequirement) {
          artifacts.requirements[idx] = {
            ...existingRequirement,
            reviewStatus: 'edited',
            ...edit.data,
          }
        }
      } else if (edit.action === 'remove' && edit.tempId) {
        artifacts.requirements = artifacts.requirements.filter(
          (r) => r.tempId !== edit.tempId,
        )
      }
    }

    await DesignSessionService.updateArtifacts(sessionId, artifacts)
  }

  async confirmStage(
    sessionId: string,
    stage: 'toolset' | 'requirements' | 'bom' | 'cad' | 'assembly',
    options?: { force?: boolean },
  ): Promise<void> {
    const transitions: Record<
      typeof stage,
      { reviewStage: DesignSessionStage; nextStage: DesignSessionStage }
    > = {
      toolset: {
        reviewStage: 'toolset_review',
        nextStage: 'requirements_drafting',
      },
      requirements: {
        reviewStage: 'requirements_review',
        nextStage: 'bom_drafting',
      },
      bom: { reviewStage: 'bom_review', nextStage: 'materialization' },
      cad: { reviewStage: 'cad_review', nextStage: 'assembly_composition' },
      assembly: { reviewStage: 'assembly_review', nextStage: 'complete' },
    }
    const { reviewStage, nextStage } = transitions[stage]

    const session = await DesignSessionService.getById(sessionId)

    // Review gate: every AI-proposed item must be resolved (accepted, edited,
    // or rejected) before the gate closes. `force` overrides.
    if (!options?.force && session?.artifacts) {
      const unresolved = countUnresolvedItems(session.artifacts, stage)
      if (unresolved > 0) {
        const noun = stage === 'requirements' ? 'requirement' : 'BOM item'
        throw new ValidationError(
          `${unresolved} ${noun}${unresolved === 1 ? ' is' : 's are'} still unreviewed — accept, edit, or reject each item, or confirm again with force to skip review`,
        )
      }
    }

    // Snapshot the user-approved state at every gate — the diff base for
    // review stages and the restore target for reopenStage.
    if (session?.artifacts) {
      await DesignSnapshotService.create(
        sessionId,
        reviewStage,
        session.artifacts,
        session.llmHistory?.length ?? 0,
      )
    }

    await DesignSessionService.updateStage(sessionId, nextStage)
    if (nextStage === 'complete') {
      await DesignSessionService.updateStatus(sessionId, 'completed')
    }
  }

  /**
   * Reopen a previously confirmed review gate, restoring the artifacts that
   * were approved there. This is the only sanctioned way to move a session
   * backward — the raw PATCH stage endpoint rejects backward moves.
   */
  async reopenStage(
    sessionId: string,
    targetStage: ReopenableStage,
  ): Promise<void> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new NotFoundError('DesignSession', sessionId)

    if (session.stage === 'complete' || session.status === 'completed') {
      throw new ValidationError('Cannot reopen a stage on a completed session')
    }
    if (session.artifacts?.materializationResult) {
      throw new ValidationError(
        'Cannot reopen a stage after materialization — the session has created PLM items. Fork the session to explore an alternative.',
      )
    }
    if (
      stageIndex(targetStage) >= stageIndex(session.stage as DesignSessionStage)
    ) {
      throw new ValidationError(
        `Cannot reopen ${targetStage}: it is not earlier than the current stage (${session.stage})`,
      )
    }

    const snapshot = await DesignSnapshotService.getLatestForStage(
      sessionId,
      targetStage,
    )
    if (snapshot) {
      const restored: DesignArtifacts = {
        ...snapshot.artifacts,
        pendingClarificationId: undefined,
        pendingClarification: undefined,
      }
      await DesignSessionService.updateArtifacts(sessionId, restored)
      // Truncate the conversation to what the AI knew when this state was
      // approved — otherwise re-runs feed it context from the abandoned pass.
      const history = session.llmHistory ?? []
      await DesignSessionService.saveLlmHistory(
        sessionId,
        history.slice(0, snapshot.llmHistoryLength),
      )
    } else {
      // Legacy sessions predate snapshots: keep current artifacts but clear
      // everything downstream of the reopened gate.
      const artifacts: DesignArtifacts = {
        ...(session.artifacts ?? {
          description: '',
          requirements: [],
          bom: null,
          clarifications: [],
          userMessages: [],
        }),
        pendingClarificationId: undefined,
        pendingClarification: undefined,
        cadGenerationState: undefined,
      }
      if (targetStage === 'toolset_review') {
        artifacts.requirements = artifacts.requirements.filter(
          (r) => r.source === 'user',
        )
        artifacts.bom = null
      } else if (targetStage === 'requirements_review') {
        artifacts.bom = null
      }
      await DesignSessionService.updateArtifacts(sessionId, artifacts)
    }

    await DesignSessionService.updateStage(sessionId, targetStage)
    if (session.status !== 'active') {
      await DesignSessionService.updateStatus(sessionId, 'active')
    }
  }

  async materialize(sessionId: string): Promise<MaterializationResult> {
    const session = await DesignSessionService.getById(sessionId)
    if (!session) throw new Error(`Session ${sessionId} not found`)

    return MaterializationService.execute(session, session.userId)
  }
}

// Singleton instance
export const designEngine = new CollaborativeDesignEngine()
