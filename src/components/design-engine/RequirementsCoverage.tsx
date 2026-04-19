/**
 * RequirementsCoverage - Shows how many requirements are covered by the BOM
 */

import { AlertTriangle, CheckCircle } from 'lucide-react'
import type { RequirementDraft } from '@/lib/design-engine/types'
import { cn } from '@/lib/utils'

interface RequirementsCoverageProps {
  coverage: Record<string, Array<string>>
  uncoveredRequirements: Array<string>
  requirements: Array<RequirementDraft>
  totalRequirements: number
  className?: string
}

export function RequirementsCoverage({
  coverage,
  uncoveredRequirements,
  requirements,
  totalRequirements,
  className,
}: RequirementsCoverageProps) {
  const reqNameMap = new Map(requirements.map((r) => [r.tempId, r.name]))
  const coveredCount = Object.keys(coverage).length
  const allCovered = uncoveredRequirements.length === 0 && totalRequirements > 0

  return (
    <div className={cn('space-y-2', className)}>
      <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-400">
        Requirements Coverage
      </h4>

      <div className="flex items-center gap-2">
        {allCovered ? (
          <CheckCircle className="h-4 w-4 text-green-500" />
        ) : (
          <AlertTriangle className="h-4 w-4 text-yellow-500" />
        )}
        <span className="text-sm text-slate-700 dark:text-slate-300">
          {coveredCount} of {totalRequirements} requirements covered
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-2 w-full bg-slate-200 dark:bg-slate-700 rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all',
            allCovered ? 'bg-green-500' : 'bg-yellow-500',
          )}
          style={{
            width: `${totalRequirements > 0 ? (coveredCount / totalRequirements) * 100 : 0}%`,
          }}
        />
      </div>

      {/* Uncovered list */}
      {uncoveredRequirements.length > 0 && (
        <div className="text-xs text-yellow-600 dark:text-yellow-400">
          <p className="font-medium">Uncovered requirements:</p>
          <ul className="list-disc ml-4 mt-1 space-y-0.5">
            {uncoveredRequirements.map((reqId) => (
              <li key={reqId} className="text-slate-500 dark:text-slate-400">
                {reqNameMap.get(reqId) ?? reqId}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
