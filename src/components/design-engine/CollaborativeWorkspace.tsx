/**
 * CollaborativeWorkspace - Main two-panel layout for the design engine
 */

import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Cpu, Layers, Lightbulb, Pause, Play, X } from 'lucide-react'
import { StageIndicator } from './StageIndicator'
import { ArtifactPanel } from './ArtifactPanel'
import { ActivityFeed } from './ActivityFeed'
import { ManufacturingTab } from './ManufacturingTab'
import { MaterializationPreview } from './MaterializationPreview'
import { MaterializationResult } from './MaterializationResult'
import { CadGenerationPanel } from './CadGenerationPanel'
import { CadReviewPanel } from './CadReviewPanel'
import { AssemblyPanel } from './AssemblyPanel'
import { AssemblyReviewPanel } from './AssemblyReviewPanel'
import type {
  DesignArtifacts,
  DesignSessionStage,
  MaterializationPreview as PreviewType,
  RequirementDraft,
  MaterializationResult as ResultType,
} from '@/lib/design-engine/types'
import { useDesignEngineStream } from '@/hooks/useDesignEngineStream'
import { Button } from '@/components/ui/Button'

interface CollaborativeWorkspaceProps {
  sessionId: string
  initialSession: {
    title: string | null
    stage: string
    status: string
    artifacts: DesignArtifacts | null
  }
}

export function CollaborativeWorkspace({
  sessionId,
  initialSession,
}: CollaborativeWorkspaceProps) {
  const navigate = useNavigate()
  const stream = useDesignEngineStream({ sessionId })

  const [materializationPreview, setMaterializationPreview] =
    useState<PreviewType | null>(null)
  const [materializationResult, setMaterializationResult] =
    useState<ResultType | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [isMaterializing, setIsMaterializing] = useState(false)
  const [materializationError, setMaterializationError] = useState<
    string | null
  >(null)

  // Initialize from session data
  useEffect(() => {
    if (initialSession.artifacts) {
      stream.initializeArtifacts(
        initialSession.artifacts,
        initialSession.stage as DesignSessionStage,
      )
    }
  }, [])

  const handleStartToolset = useCallback(() => {
    stream.sendAction('start_toolset')
  }, [stream])

  const handleConfirmToolset = useCallback(() => {
    stream.sendAction('confirm_toolset')
  }, [stream])

  const handleStartRequirements = useCallback(() => {
    stream.sendAction('start_requirements')
  }, [stream])

  const handleStartBom = useCallback(() => {
    stream.sendAction('start_bom')
  }, [stream])

  const handleConfirmRequirements = useCallback(() => {
    stream.sendAction('confirm_requirements')
  }, [stream])

  const handleConfirmBom = useCallback(() => {
    stream.sendAction('confirm_bom')
  }, [stream])

  const handleStartCadGeneration = useCallback(() => {
    stream.sendAction('start_cad_generation')
  }, [stream])

  const handleConfirmCad = useCallback(() => {
    stream.sendAction('confirm_cad')
  }, [stream])

  const handleStartAssemblyComposition = useCallback(() => {
    stream.sendAction('start_assembly_composition')
  }, [stream])

  const handleConfirmAssembly = useCallback(() => {
    stream.sendAction('confirm_assembly')
  }, [stream])

  const handleRegeneratePart = useCallback(
    (tempId: string, feedback?: string) => {
      stream.sendAction('regenerate_part', { tempId, feedback })
    },
    [stream],
  )

  const handleUpdateDescription = useCallback(
    async (description: string) => {
      await fetch(`/api/v1/design-engine/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
    },
    [sessionId],
  )

  const handleUpdateRequirement = useCallback(
    async (tempId: string, data: Partial<RequirementDraft>) => {
      // Update locally in artifacts then persist
      const updated = { ...stream.artifacts }
      const idx = updated.requirements.findIndex((r) => r.tempId === tempId)
      if (idx >= 0) {
        updated.requirements = [...updated.requirements]
        updated.requirements[idx] = { ...updated.requirements[idx], ...data }
        await fetch(`/api/v1/design-engine/sessions/${sessionId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ artifacts: updated }),
        })
      }
    },
    [sessionId, stream.artifacts],
  )

  const handleRemoveRequirement = useCallback(
    async (tempId: string) => {
      const updated = {
        ...stream.artifacts,
        requirements: stream.artifacts.requirements.filter(
          (r) => r.tempId !== tempId,
        ),
      }
      await fetch(`/api/v1/design-engine/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifacts: updated }),
      })
    },
    [sessionId, stream.artifacts],
  )

  const handleAddRequirement = useCallback(
    async (data: Partial<RequirementDraft>) => {
      const newReq: RequirementDraft = {
        tempId: crypto.randomUUID(),
        name: data.name ?? '',
        description: data.description ?? '',
        requirementType: data.requirementType ?? 'Functional',
        priority: data.priority ?? 'medium',
        verificationMethod: data.verificationMethod ?? 'Analysis',
        rationale: data.rationale ?? '',
        confidence: data.confidence ?? 1,
        source: 'user',
      }
      const updated = {
        ...stream.artifacts,
        requirements: [...stream.artifacts.requirements, newReq],
      }
      await fetch(`/api/v1/design-engine/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ artifacts: updated }),
      })
    },
    [sessionId, stream.artifacts],
  )

  const handleAnswer = useCallback(
    (questionId: string, answer: string) => {
      stream.sendAction('answer_clarification', { questionId, answer })
    },
    [stream],
  )

  const handleSendMessage = useCallback(
    (message: string) => {
      stream.sendMessage(message)
    },
    [stream],
  )

  // Load materialization preview when entering that stage
  useEffect(() => {
    if (stream.currentStage === 'materialization' && !materializationPreview) {
      loadPreview()
    }
  }, [stream.currentStage])

  const loadPreview = async () => {
    setIsLoadingPreview(true)
    try {
      const response = await fetch(
        `/api/v1/design-engine/sessions/${sessionId}/materialize`,
      )
      if (response.ok) {
        const data = await response.json()
        setMaterializationPreview(data.data?.preview ?? null)
      }
    } finally {
      setIsLoadingPreview(false)
    }
  }

  const handleMaterialize = async () => {
    setIsMaterializing(true)
    setMaterializationError(null)
    try {
      const response = await fetch(
        `/api/v1/design-engine/sessions/${sessionId}/materialize`,
        { method: 'POST' },
      )
      if (response.ok) {
        const data = await response.json()
        const result = data.data?.result ?? null
        setMaterializationResult(result)
      } else {
        const errorData = await response.json().catch(() => null)
        setMaterializationError(
          errorData?.error?.message ??
            `Materialization failed (${response.status})`,
        )
      }
    } catch (err) {
      setMaterializationError(
        err instanceof Error
          ? err.message
          : 'Network error during materialization',
      )
    } finally {
      setIsMaterializing(false)
    }
  }

  const handleNavigate = (url: string) => {
    navigate({ to: url })
  }

  // Determine if we need the start button
  const showStartToolset = stream.currentStage === 'idle' && !stream.isStreaming
  const showStartRequirements =
    stream.currentStage === 'requirements_drafting' &&
    !stream.isStreaming &&
    stream.artifacts.requirements.length === 0
  const showStartBom =
    stream.currentStage === 'bom_drafting' && !stream.isStreaming
  const showGenerateCad =
    materializationResult !== null &&
    stream.currentStage !== 'cad_generation' &&
    stream.currentStage !== 'cad_review' &&
    stream.currentStage !== 'assembly_composition' &&
    stream.currentStage !== 'assembly_review' &&
    stream.currentStage !== 'complete' &&
    !stream.isStreaming
  const showStartAssembly =
    stream.currentStage === 'assembly_composition' && !stream.isStreaming

  return (
    <div className="h-[calc(100dvh-3rem)] flex flex-col overflow-hidden bg-white dark:bg-slate-900">
      {/* Top bar */}
      <div className="flex-shrink-0 flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-4 py-2">
        <div className="flex items-center gap-3">
          <Lightbulb className="h-5 w-5 text-cyan-500" />
          <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate max-w-md">
            {initialSession.title ?? 'Design Session'}
          </h1>
        </div>
        <StageIndicator currentStage={stream.currentStage} />
        <div className="flex items-center gap-2">
          {stream.isStreaming && (
            <Button
              variant="ghost"
              size="sm"
              onClick={stream.pause}
              className="h-7 text-xs gap-1"
            >
              <Pause className="h-3 w-3" />
              Pause
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate({ to: '/' })}
            className="h-7 text-xs gap-1"
          >
            <X className="h-3 w-3" />
            Close
          </Button>
        </div>
      </div>

      {/* Main content: two-panel layout */}
      <div className="flex-1 grid grid-cols-[3fr_2fr] min-h-0">
        {/* Left panel: Artifacts */}
        <div className="border-r border-slate-200 dark:border-slate-700 overflow-hidden flex flex-col">
          {stream.currentStage === 'toolset_establishment' ||
          stream.currentStage === 'toolset_review' ? (
            <div className="p-4 overflow-y-auto flex-1">
              <ManufacturingTab
                toolset={stream.artifacts.toolset}
                bom={stream.artifacts.bom}
                currentStage={stream.currentStage}
                onConfirmToolset={handleConfirmToolset}
              />
            </div>
          ) : stream.currentStage === 'assembly_review' &&
            stream.artifacts.bom ? (
            <div className="p-4 overflow-y-auto flex-1">
              <AssemblyReviewPanel
                rootAssembly={stream.artifacts.bom.rootAssembly}
                onConfirmAssembly={handleConfirmAssembly}
                onRecompose={handleStartAssemblyComposition}
              />
            </div>
          ) : stream.currentStage === 'assembly_composition' &&
            stream.artifacts.bom ? (
            <div className="p-4 overflow-y-auto flex-1">
              <AssemblyPanel
                rootAssembly={stream.artifacts.bom.rootAssembly}
                cadState={stream.artifacts.cadGenerationState}
              />
            </div>
          ) : stream.currentStage === 'cad_review' && stream.artifacts.bom ? (
            <div className="p-4 overflow-y-auto flex-1">
              <CadReviewPanel
                rootAssembly={stream.artifacts.bom.rootAssembly}
                onRegeneratePart={handleRegeneratePart}
                onConfirmCad={handleConfirmCad}
                isRegenerating={stream.isStreaming}
              />
            </div>
          ) : stream.currentStage === 'cad_generation' &&
            stream.artifacts.bom ? (
            <div className="p-4 overflow-y-auto flex-1">
              <CadGenerationPanel
                rootAssembly={stream.artifacts.bom.rootAssembly}
                cadState={stream.artifacts.cadGenerationState}
              />
            </div>
          ) : (stream.currentStage === 'complete' ||
              stream.currentStage === 'materialization') &&
            materializationResult ? (
            <div className="p-4 overflow-y-auto flex-1">
              <MaterializationResult
                result={materializationResult}
                onNavigate={handleNavigate}
                onStartNew={() => navigate({ to: '/' })}
              />
            </div>
          ) : stream.currentStage === 'materialization' ? (
            <div className="p-4 overflow-y-auto flex-1">
              <MaterializationPreview
                preview={materializationPreview}
                isLoading={isLoadingPreview}
                onMaterialize={handleMaterialize}
                isMaterializing={isMaterializing}
              />
            </div>
          ) : (
            <ArtifactPanel
              artifacts={stream.artifacts}
              currentStage={stream.currentStage}
              onUpdateDescription={handleUpdateDescription}
              onUpdateRequirement={handleUpdateRequirement}
              onRemoveRequirement={handleRemoveRequirement}
              onAddRequirement={handleAddRequirement}
              onConfirmRequirements={handleConfirmRequirements}
              onConfirmBom={handleConfirmBom}
              className="flex-1"
            />
          )}
        </div>

        {/* Right panel: Activity Feed */}
        <div className="overflow-hidden flex flex-col">
          {/* Start button for initial stages */}
          {(showStartToolset ||
            showStartRequirements ||
            showStartBom ||
            showGenerateCad ||
            showStartAssembly) && (
            <div className="p-4 border-b border-slate-200 dark:border-slate-700">
              <Button
                variant="default"
                onClick={
                  showStartToolset
                    ? handleStartToolset
                    : showStartRequirements
                      ? handleStartRequirements
                      : showStartBom
                        ? handleStartBom
                        : showGenerateCad
                          ? handleStartCadGeneration
                          : handleStartAssemblyComposition
                }
                className="w-full gap-2"
              >
                {showGenerateCad ? (
                  <Cpu className="h-4 w-4" />
                ) : showStartAssembly ? (
                  <Layers className="h-4 w-4" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                {showStartToolset
                  ? 'Start Toolset Establishment'
                  : showStartRequirements
                    ? 'Start Requirements Analysis'
                    : showStartBom
                      ? 'Start BOM Generation'
                      : showGenerateCad
                        ? 'Generate CAD Files'
                        : 'Start Assembly Composition'}
              </Button>
            </div>
          )}

          <ActivityFeed
            events={stream.events}
            isStreaming={stream.isStreaming}
            onAnswer={handleAnswer}
            onSendMessage={handleSendMessage}
            currentStage={stream.currentStage}
            className="flex-1"
          />

          {/* Error display */}
          {(stream.error || materializationError) && (
            <div className="p-3 bg-red-50 dark:bg-red-900/20 border-t border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
              {stream.error || materializationError}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
