/**
 * ArtifactDiffLegend - Compact legend for the review-stage diff view.
 */

import { DIFF_STATUS_STYLES } from './diff-styles'
import type { DiffStatus } from '@/lib/design-engine/artifact-diff'
import { cn } from '@/lib/utils'

const LEGEND_STATUSES: Array<DiffStatus> = ['added', 'modified', 'removed']

export function ArtifactDiffLegend({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 text-[10px] text-slate-500 dark:text-slate-400',
        className,
      )}
    >
      <span className="font-medium">Changes since last confirm:</span>
      {LEGEND_STATUSES.map((status) => {
        const style = DIFF_STATUS_STYLES[status]
        const Icon = style.Icon
        return (
          <span key={status} className="flex items-center gap-1">
            <span
              className={cn(
                'flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium',
                style.badge,
              )}
            >
              {Icon && <Icon className="h-2 w-2" />}
              {style.label}
            </span>
          </span>
        )
      })}
    </div>
  )
}
