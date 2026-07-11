/**
 * StageIndicator - Visual stepper for design engine stages
 *
 * Completed toolset/requirements/BOM steps become clickable when `onReopen`
 * is provided, letting the user reopen a confirmed review gate.
 */

import { Check, Circle } from 'lucide-react'
import type { DesignSessionStage, ReopenableStage } from '@/lib/design-engine/types'
import { cn } from '@/lib/utils'

const STAGES = [
  {
    key: 'toolset',
    label: 'Toolset',
    activeStages: ['toolset_establishment', 'toolset_review'] as Array<string>,
    reopenTarget: 'toolset_review' as ReopenableStage | undefined,
  },
  {
    key: 'requirements',
    label: 'Requirements',
    activeStages: [
      'requirements_drafting',
      'requirements_review',
    ] as Array<string>,
    reopenTarget: 'requirements_review' as ReopenableStage | undefined,
  },
  {
    key: 'bom',
    label: 'BOM',
    activeStages: ['bom_drafting', 'bom_review'] as Array<string>,
    reopenTarget: 'bom_review' as ReopenableStage | undefined,
  },
  {
    key: 'materialize',
    label: 'Materialize',
    activeStages: ['materialization'] as Array<string>,
    reopenTarget: undefined as ReopenableStage | undefined,
  },
  {
    key: 'cad',
    label: 'CAD',
    activeStages: ['cad_generation', 'cad_review'] as Array<string>,
    reopenTarget: undefined as ReopenableStage | undefined,
  },
  {
    key: 'assembly',
    label: 'Assembly',
    activeStages: [
      'assembly_composition',
      'assembly_review',
      'complete',
    ] as Array<string>,
    reopenTarget: undefined as ReopenableStage | undefined,
  },
] as const

function getStageIndex(stage: DesignSessionStage): number {
  if (stage === 'idle') return -1
  if (stage === 'toolset_establishment' || stage === 'toolset_review') return 0
  if (stage === 'requirements_drafting' || stage === 'requirements_review')
    return 1
  if (stage === 'bom_drafting' || stage === 'bom_review') return 2
  if (stage === 'materialization') return 3
  if (stage === 'cad_generation' || stage === 'cad_review') return 4
  if (
    stage === 'assembly_composition' ||
    stage === 'assembly_review' ||
    stage === 'complete'
  )
    return 5
  return -1
}

interface StageIndicatorProps {
  currentStage: DesignSessionStage
  className?: string
  /** When set, completed reopenable stages render as clickable buttons. */
  onReopen?: (targetStage: ReopenableStage) => void
  /** Disables reopen clicks (e.g. while streaming or after materialization). */
  reopenDisabled?: boolean
}

export function StageIndicator({
  currentStage,
  className,
  onReopen,
  reopenDisabled,
}: StageIndicatorProps) {
  const currentIndex = getStageIndex(currentStage)

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {STAGES.map((stage, index) => {
        const isCompleted = currentIndex > index
        const isActive = stage.activeStages.includes(currentStage)
        const canReopen =
          isCompleted &&
          !reopenDisabled &&
          stage.reopenTarget !== undefined &&
          onReopen !== undefined

        const content = (
          <>
            {isCompleted ? (
              <div className="flex h-5 w-5 items-center justify-center rounded-full bg-cyan-500 text-white">
                <Check className="h-3 w-3" />
              </div>
            ) : (
              <div
                className={cn(
                  'flex h-5 w-5 items-center justify-center rounded-full',
                  isActive
                    ? 'bg-cyan-100 text-cyan-600 ring-2 ring-cyan-400 dark:bg-cyan-900 dark:text-cyan-300'
                    : 'bg-slate-200 text-slate-400 dark:bg-slate-700 dark:text-slate-500',
                )}
              >
                <Circle className="h-2 w-2 fill-current" />
              </div>
            )}
            <span
              className={cn(
                'text-xs font-medium',
                isActive
                  ? 'text-cyan-700 dark:text-cyan-300'
                  : isCompleted
                    ? 'text-slate-700 dark:text-slate-300'
                    : 'text-slate-400 dark:text-slate-500',
              )}
            >
              {stage.label}
            </span>
          </>
        )

        return (
          <div key={stage.key} className="flex items-center gap-2">
            {index > 0 && (
              <div
                className={cn(
                  'h-0.5 w-8',
                  isCompleted
                    ? 'bg-cyan-500'
                    : 'bg-slate-300 dark:bg-slate-600',
                )}
              />
            )}
            {canReopen ? (
              <button
                type="button"
                onClick={() => onReopen(stage.reopenTarget!)}
                title={`Reopen ${stage.label} review`}
                className="flex items-center gap-1.5 rounded px-1 py-0.5 -mx-1 hover:bg-cyan-50 dark:hover:bg-cyan-900/30 cursor-pointer"
              >
                {content}
              </button>
            ) : (
              <div className="flex items-center gap-1.5">{content}</div>
            )}
          </div>
        )
      })}
    </div>
  )
}
