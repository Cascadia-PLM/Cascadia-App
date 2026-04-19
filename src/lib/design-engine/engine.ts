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
import { runToolsetEstablishmentStage } from './stages/toolset-establishment'
import { runRequirementsStage } from './stages/requirements'
import { runBomStage } from './stages/bom'
import { runCadGenerationStage } from './stages/cad-generation'
import { runAssemblyCompositionStage } from './stages/assembly-composition'
import { MaterializationService } from './materialize'
import type {
  DesignEngine,
  DesignSessionContext,
  LlmHistoryEntry,
  MaterializationResult,
  RequirementEdit,
  StageEvent,
} from './types'

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
        if (idx >= 0) {
          artifacts.requirements[idx] = {
            ...artifacts.requirements[idx],
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
  ): Promise<void> {
    if (stage === 'toolset') {
      await DesignSessionService.updateStage(sessionId, 'requirements_drafting')
    } else if (stage === 'requirements') {
      await DesignSessionService.updateStage(sessionId, 'bom_drafting')
    } else if (stage === 'bom') {
      await DesignSessionService.updateStage(sessionId, 'materialization')
    } else if (stage === 'cad') {
      await DesignSessionService.updateStage(sessionId, 'assembly_composition')
    } else if (stage === 'assembly') {
      await DesignSessionService.updateStage(sessionId, 'complete')
      await DesignSessionService.updateStatus(sessionId, 'completed')
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
