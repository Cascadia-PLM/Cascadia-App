import { useLifecyclePhases } from '@/lib/hooks/useLifecyclePhases'
import { cn } from '@/lib/utils'

interface PhaseBadgeProps {
  itemType: string
  state: string
  className?: string
}

const phaseColorMap: Record<string, string> = {
  gray: 'bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300',
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300',
  green: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  yellow:
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/50 dark:text-yellow-300',
  orange:
    'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  purple:
    'bg-purple-100 text-purple-700 dark:bg-purple-900/50 dark:text-purple-300',
  cyan: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-300',
}

export function PhaseBadge({ itemType, state, className }: PhaseBadgeProps) {
  const { resolvePhase, loading } = useLifecyclePhases(itemType)

  if (loading) {
    return (
      <span
        className={cn(
          'inline-block h-5 w-16 rounded-full bg-slate-200 dark:bg-slate-700 animate-pulse',
          className,
        )}
      />
    )
  }

  const phase = resolvePhase(state)
  if (!phase) return null

  const colorClasses =
    phaseColorMap[phase.color ?? 'gray'] ?? phaseColorMap.gray

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        colorClasses,
        className,
      )}
    >
      {phase.name}
    </span>
  )
}
