/**
 * ArtifactPanel - Left panel container for all design artifacts
 *
 * Shows description, requirements, BOM, and materialization sections.
 * Sections are locked/unlocked based on the current stage.
 */

import { useState } from 'react'
import { Check, FileText, Pencil, Wrench } from 'lucide-react'
import { RequirementsPanel } from './RequirementsPanel'
import { BomDraftPanel } from './BomDraftPanel'
import type {
  BomNodeDraft,
  DesignArtifacts,
  DesignSessionStage,
  RequirementDraft,
  ReviewStatus,
} from '@/lib/design-engine/types'
import type {
  BomDiff,
  RequirementsDiff,
} from '@/lib/design-engine/artifact-diff'
import type { KnownToolSubtype } from '@/lib/items/types/tool'
import { TOOL_SUBTYPES } from '@/lib/items/types/tool'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui'
import { Textarea } from '@/components/ui/Textarea'
import { cn } from '@/lib/utils'

interface ArtifactPanelProps {
  artifacts: DesignArtifacts
  currentStage: DesignSessionStage
  isStreaming?: boolean
  onUpdateDescription?: (description: string) => void
  onUpdateRequirement?: (
    tempId: string,
    data: Partial<RequirementDraft>,
  ) => void
  onAddRequirement?: (data: Partial<RequirementDraft>) => void
  onSetRequirementReviewStatus?: (
    tempId: string,
    status: ReviewStatus,
    note?: string,
  ) => void
  onAcceptAllRequirements?: () => void
  onConfirmRequirements?: (options?: { force?: boolean }) => void
  onConfirmBom?: (options?: { force?: boolean }) => void
  onUpdateBomNode?: (tempId: string, patch: Partial<BomNodeDraft>) => void
  onRejectBomNode?: (tempId: string, reason?: string) => void
  onSetBomNodeReviewStatus?: (tempId: string, status: ReviewStatus) => void
  onAcceptAllBomNodes?: () => void
  onAddBomChild?: (parentTempId: string, data: Partial<BomNodeDraft>) => void
  requirementsDiff?: RequirementsDiff | null
  bomDiff?: BomDiff | null
  className?: string
}

export function ArtifactPanel({
  artifacts,
  currentStage,
  isStreaming,
  onUpdateDescription,
  onUpdateRequirement,
  onAddRequirement,
  onSetRequirementReviewStatus,
  onAcceptAllRequirements,
  onConfirmRequirements,
  onConfirmBom,
  onUpdateBomNode,
  onRejectBomNode,
  onSetBomNodeReviewStatus,
  onAcceptAllBomNodes,
  onAddBomChild,
  requirementsDiff,
  bomDiff,
  className,
}: ArtifactPanelProps) {
  const [editingDescription, setEditingDescription] = useState(false)
  const [descriptionDraft, setDescriptionDraft] = useState(
    artifacts.description,
  )

  const saveDescription = () => {
    onUpdateDescription?.(descriptionDraft)
    setEditingDescription(false)
  }

  return (
    <div className={cn('space-y-6 overflow-y-auto p-4', className)}>
      {/* Description Section */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 flex items-center gap-1.5">
            <FileText className="h-4 w-4" />
            Description
          </h3>
          {!editingDescription && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setDescriptionDraft(artifacts.description)
                setEditingDescription(true)
              }}
              className="h-7 text-xs gap-1"
            >
              <Pencil className="h-3 w-3" />
              Edit
            </Button>
          )}
        </div>

        {editingDescription ? (
          <div className="space-y-2">
            <Textarea
              value={descriptionDraft}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              className="text-sm min-h-[80px]"
              autoFocus
            />
            <div className="flex gap-2">
              <Button
                variant="default"
                size="sm"
                onClick={saveDescription}
                className="h-7 text-xs"
              >
                <Check className="h-3 w-3 mr-1" />
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditingDescription(false)}
                className="h-7 text-xs"
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-800 rounded-lg p-3 whitespace-pre-wrap">
            {artifacts.description || 'No description provided'}
          </p>
        )}
      </section>

      {/* Toolset Summary (compact, visible after toolset establishment) */}
      {artifacts.toolset && artifacts.toolset.tools.length > 0 && (
        <section className="rounded-lg bg-slate-50 dark:bg-slate-800/50 p-3">
          <h3 className="text-xs font-semibold text-slate-500 dark:text-slate-400 flex items-center gap-1.5 mb-2">
            <Wrench className="h-3 w-3" />
            Manufacturing Toolset
            <Badge variant="outline" className="ml-auto text-[10px]">
              {artifacts.toolset.scope.replace(/_/g, ' ')}
            </Badge>
          </h3>
          <div className="space-y-1">
            {artifacts.toolset.tools.map((tool) => (
              <div
                key={tool.id}
                className="text-xs text-slate-600 dark:text-slate-400 flex items-center gap-1.5"
              >
                <span className="font-medium">{tool.name}</span>
                <span className="text-slate-400 dark:text-slate-500">
                  (
                  {(
                    TOOL_SUBTYPES[tool.toolSubtype as KnownToolSubtype] as
                      | { label: string }
                      | undefined
                  )?.label ?? tool.toolSubtype}
                  )
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Requirements Section */}
      <section>
        <RequirementsPanel
          requirements={artifacts.requirements}
          currentStage={currentStage}
          isStreaming={isStreaming}
          onUpdate={onUpdateRequirement}
          onAdd={onAddRequirement}
          onSetReviewStatus={onSetRequirementReviewStatus}
          onAcceptAll={onAcceptAllRequirements}
          onConfirm={onConfirmRequirements}
          diff={requirementsDiff}
        />
      </section>

      {/* BOM Section */}
      <section>
        <BomDraftPanel
          bom={artifacts.bom}
          currentStage={currentStage}
          totalRequirements={artifacts.requirements.length}
          requirements={artifacts.requirements}
          bomRejections={artifacts.bomRejections}
          onConfirm={onConfirmBom}
          onUpdateNode={onUpdateBomNode}
          onRejectNode={onRejectBomNode}
          onSetNodeReviewStatus={onSetBomNodeReviewStatus}
          onAcceptAllNodes={onAcceptAllBomNodes}
          onAddChild={onAddBomChild}
          diff={bomDiff}
        />
      </section>
    </div>
  )
}
