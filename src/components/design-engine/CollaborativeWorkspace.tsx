/**
 * CollaborativeWorkspace - Main two-panel layout for the design engine
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
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
  LlmHistoryEntry,
  MaterializationPreview as PreviewType,
  ReopenableStage,
  MaterializationResult as ResultType,
} from '@/lib/design-engine/types'
import { useDesignEngineStream } from '@/hooks/useDesignEngineStream'
import { useArtifactMutations } from '@/hooks/useArtifactMutations'
import { Button } from '@/components/ui/Button'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { diffBom, diffRequirements } from '@/lib/design-engine/artifact-diff'

interface CollaborativeWorkspaceProps {
  sessionId: string
  initialSession: {
    title: string | null
    stage: string
    status: string
    artifacts: DesignArtifacts | null
    llmHistory?: Array<LlmHistoryEntry> | null
  }
}

export function CollaborativeWorkspace({
  sessionId,
  initialSession,
}: CollaborativeWorkspaceProps) {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const stream = useDesignEngineStream({ sessionId })
  const mutations = useArtifactMutations({
    sessionId,
    artifacts: stream.artifacts,
    currentStage: stream.currentStage,
  })

  const [materializationPreview, setMaterializationPreview] =
    useState<PreviewType | null>(null)
  const [materializationResult, setMaterializationResult] =
    useState<ResultType | null>(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [isMaterializing, setIsMaterializing] = useState(false)
  const [materializationError, setMaterializationError] = useState<
    string | null
  >(null)

  // Diff base for review stages: the latest confirmed snapshot of the SAME
  // gate. Exists only after a reopen/re-run — first-pass reviews show no diff.
  const [diffBase, setDiffBase] = useState<DesignArtifacts | null>(null)

  useEffect(() => {
    const stage = stream.currentStage
    if (stage !== 'requirements_review' && stage !== 'bom_review') {
      setDiffBase(null)
      return
    }
    let cancelled = false
    const loadBase = async () => {
      try {
        const listRes = await fetch(
          `/api/v1/design-engine/sessions/${sessionId}/snapshots`,
        )
        if (!listRes.ok) return
        const listData = await listRes.json()
        const snapshots: Array<{ id: string; stage: string }> =
          listData.data?.snapshots ?? []
        // Newest first — the latest snapshot of this same review gate
        const match = snapshots.find((s) => s.stage === stage)
        if (!match) {
          if (!cancelled) setDiffBase(null)
          return
        }
        const snapRes = await fetch(
          `/api/v1/design-engine/sessions/${sessionId}/snapshots/${match.id}`,
        )
        if (!snapRes.ok) return
        const snapData = await snapRes.json()
        if (!cancelled) {
          setDiffBase(snapData.data?.snapshot?.artifacts ?? null)
        }
      } catch {
        // Diff view is best-effort — review works without it
      }
    }
    loadBase()
    return () => {
      cancelled = true
    }
  }, [stream.currentStage, sessionId])

  const requirementsDiff = useMemo(
    () =>
      diffBase && stream.currentStage === 'requirements_review'
        ? diffRequirements(diffBase.requirements, stream.artifacts.requirements)
        : null,
    [diffBase, stream.currentStage, stream.artifacts.requirements],
  )

  const bomDiff = useMemo(
    () =>
      diffBase && stream.currentStage === 'bom_review'
        ? diffBom(diffBase.bom, stream.artifacts.bom)
        : null,
    [diffBase, stream.currentStage, stream.artifacts.bom],
  )

  // Initialize from session data
  useEffect(() => {
    if (initialSession.artifacts) {
      stream.initializeArtifacts(
        initialSession.artifacts,
        initialSession.stage as DesignSessionStage,
        initialSession.llmHistory,
      )
    }
  }, [])

  const handleStartToolset = useCallback(() => {
    stream.sendAction('start_toolset')
  }, [stream])

  const handleResumeToolset = useCallback(() => {
    stream.sendAction('resume')
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

  const handleConfirmRequirements = useCallback(
    (options?: { force?: boolean }) => {
      stream.sendAction('confirm_requirements', { force: options?.force })
    },
    [stream],
  )

  const handleConfirmBom = useCallback(
    (options?: { force?: boolean }) => {
      stream.sendAction('confirm_bom', { force: options?.force })
    },
    [stream],
  )

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

  const handleReopenStage = useCallback(
    (targetStage: ReopenableStage) => {
      const discards: Record<ReopenableStage, string> = {
        toolset_review:
          'Later drafts (requirements and BOM) revert to the state approved at this gate.',
        requirements_review:
          'The BOM draft reverts to the state approved at this gate.',
        bom_review: 'The session returns to BOM review.',
      }
      const labels: Record<ReopenableStage, string> = {
        toolset_review: 'Toolset',
        requirements_review: 'Requirements',
        bom_review: 'BOM',
      }
      confirm({
        title: `Reopen ${labels[targetStage]} review?`,
        description: `The session moves back to the ${labels[targetStage]} review gate. ${discards[targetStage]}`,
        actionLabel: 'Reopen',
        cancelLabel: 'Cancel',
        variant: 'destructive',
        onConfirm: () => {
          stream.sendAction('reopen_stage', { targetStage })
        },
      })
    },
    [stream, confirm],
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

  const handleUpdateRequirement = mutations.updateRequirement
  const handleAddRequirement = mutations.addRequirement
  const handleUpdateBomNode = mutations.updateNode
  const handleAddBomChild = mutations.addChild

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
  // Toolset establishment paused mid-run (e.g. after a clarification): offer a
  // way to continue. Hidden while a clarification is still pending — the prompt
  // in the feed drives the resume in that case.
  const showResumeToolset =
    stream.currentStage === 'toolset_establishment' &&
    !stream.isStreaming &&
    !stream.artifacts.pendingClarification
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
        <StageIndicator
          currentStage={stream.currentStage}
          onReopen={handleReopenStage}
          reopenDisabled={
            stream.isStreaming ||
            stream.currentStage === 'complete' ||
            Boolean(stream.artifacts.materializationResult)
          }
        />
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
              isStreaming={stream.isStreaming}
              onUpdateDescription={handleUpdateDescription}
              onUpdateRequirement={handleUpdateRequirement}
              onAddRequirement={handleAddRequirement}
              onSetRequirementReviewStatus={mutations.setRequirementReviewStatus}
              onAcceptAllRequirements={mutations.acceptAllRequirements}
              onConfirmRequirements={handleConfirmRequirements}
              onConfirmBom={handleConfirmBom}
              onUpdateBomNode={handleUpdateBomNode}
              onRejectBomNode={mutations.rejectNode}
              onSetBomNodeReviewStatus={mutations.setNodeReviewStatus}
              onAcceptAllBomNodes={mutations.acceptAllNodes}
              onAddBomChild={handleAddBomChild}
              requirementsDiff={requirementsDiff}
              bomDiff={bomDiff}
              onAddComment={mutations.addItemComment}
              onSetCommentResolved={mutations.setItemCommentResolved}
              className="flex-1"
            />
          )}
        </div>

        {/* Right panel: Activity Feed */}
        <div className="overflow-hidden flex flex-col">
          {/* Resume controls when toolset establishment paused mid-run */}
          {showResumeToolset && (
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 space-y-2">
              <Button
                variant="default"
                onClick={handleResumeToolset}
                className="w-full gap-2"
              >
                <Play className="h-4 w-4" />
                Continue Toolset Establishment
              </Button>
              <Button
                variant="ghost"
                onClick={handleStartRequirements}
                className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
              >
                Skip toolset — go straight to Requirements
              </Button>
            </div>
          )}

          {/* Start button for initial stages */}
          {(showStartToolset ||
            showStartRequirements ||
            showStartBom ||
            showGenerateCad ||
            showStartAssembly) && (
            <div className="p-4 border-b border-slate-200 dark:border-slate-700 space-y-2">
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
              {showStartToolset && (
                <Button
                  variant="ghost"
                  onClick={handleStartRequirements}
                  className="w-full text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  Skip toolset — go straight to Requirements
                </Button>
              )}
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
