/**
 * StageIndicator - Visual stepper for design engine stages
 */

import { Check, Circle } from 'lucide-react'
import type { DesignSessionStage } from '@/lib/design-engine/types'
import { cn } from '@/lib/utils'

const STAGES = [
  {
    key: 'toolset',
    label: 'Toolset',
    activeStages: ['toolset_establishment', 'toolset_review'] as Array<string>,
  },
  {
    key: 'requirements',
    label: 'Requirements',
    activeStages: [
      'requirements_drafting',
      'requirements_review',
    ] as Array<string>,
  },
  {
    key: 'bom',
    label: 'BOM',
    activeStages: ['bom_drafting', 'bom_review'] as Array<string>,
  },
  {
    key: 'materialize',
    label: 'Materialize',
    activeStages: ['materialization'] as Array<string>,
  },
  {
    key: 'cad',
    label: 'CAD',
    activeStages: ['cad_generation', 'cad_review'] as Array<string>,
  },
  {
    key: 'assembly',
    label: 'Assembly',
    activeStages: [
      'assembly_composition',
      'assembly_review',
      'complete',
    ] as Array<string>,
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
}

export function StageIndicator({
  currentStage,
  className,
}: StageIndicatorProps) {
  const currentIndex = getStageIndex(currentStage)

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {STAGES.map((stage, index) => {
        const isCompleted = currentIndex > index
        const isActive = stage.activeStages.includes(currentStage)

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
            <div className="flex items-center gap-1.5">
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
            </div>
          </div>
        )
      })}
    </div>
  )
}
