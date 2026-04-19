import { Circle, Minus, Plus, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'

interface DiffLegendProps {
  showUnchanged?: boolean
  className?: string
}

/**
 * Legend showing diff status colors for thread comparison view.
 */
export function DiffLegend({
  showUnchanged = true,
  className,
}: DiffLegendProps) {
  return (
    <div className={cn('flex items-center gap-4 flex-wrap', className)}>
      <div className="flex items-center gap-1.5">
        <div className="w-4 h-4 rounded-full bg-green-500 flex items-center justify-center">
          <Plus className="h-2.5 w-2.5 text-white" />
        </div>
        <span className="text-xs text-slate-600 dark:text-slate-400">
          Added
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
          <Minus className="h-2.5 w-2.5 text-white" />
        </div>
        <span className="text-xs text-slate-600 dark:text-slate-400">
          Removed
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="w-4 h-4 rounded-full bg-amber-500 flex items-center justify-center">
          <RefreshCw className="h-2.5 w-2.5 text-white" />
        </div>
        <span className="text-xs text-slate-600 dark:text-slate-400">
          Modified
        </span>
      </div>

      {showUnchanged && (
        <div className="flex items-center gap-1.5">
          <div className="w-4 h-4 rounded-full bg-slate-300 dark:bg-slate-600 flex items-center justify-center">
            <Circle className="h-2.5 w-2.5 text-slate-500 dark:text-slate-400" />
          </div>
          <span className="text-xs text-slate-600 dark:text-slate-400">
            Unchanged
          </span>
        </div>
      )}

      <div className="h-4 border-l border-slate-300 dark:border-slate-600 mx-1" />

      <div className="flex items-center gap-1.5">
        <div className="w-6 h-0.5 bg-green-500" />
        <span className="text-xs text-slate-600 dark:text-slate-400">
          New link
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <div
          className="w-6 h-0.5 bg-red-500"
          style={{ borderStyle: 'dashed' }}
        />
        <span className="text-xs text-slate-600 dark:text-slate-400">
          Removed link
        </span>
      </div>

      <div className="flex items-center gap-1.5">
        <div className="w-6 h-0.5 bg-amber-500" />
        <span className="text-xs text-slate-600 dark:text-slate-400">
          Changed link
        </span>
      </div>
    </div>
  )
}
