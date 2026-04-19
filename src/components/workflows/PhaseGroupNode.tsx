import { memo } from 'react'
import { Edit2, RotateCcw, Trash2 } from 'lucide-react'
import type { Node, NodeProps } from '@xyflow/react'
import type { LifecyclePhaseConfig } from '@/lib/types/lifecycle'

interface PhaseGroupNodeData extends Record<string, unknown> {
  phase: LifecyclePhaseConfig
  isSelected?: boolean
  onEdit?: (phase: LifecyclePhaseConfig) => void
  onDelete?: (phaseId: string) => void
}

export type PhaseGroupNodeType = Node<PhaseGroupNodeData, 'phaseGroup'>

const phaseColors: Record<
  string,
  { border: string; bg: string; headerBg: string; text: string }
> = {
  gray: {
    border: 'border-slate-400 dark:border-slate-500',
    bg: 'bg-slate-50/50 dark:bg-slate-900/30',
    headerBg: 'bg-slate-100 dark:bg-slate-800/60',
    text: 'text-slate-700 dark:text-slate-300',
  },
  blue: {
    border: 'border-blue-400 dark:border-blue-600',
    bg: 'bg-blue-50/30 dark:bg-blue-950/20',
    headerBg: 'bg-blue-100/60 dark:bg-blue-900/30',
    text: 'text-blue-700 dark:text-blue-300',
  },
  green: {
    border: 'border-green-400 dark:border-green-600',
    bg: 'bg-green-50/30 dark:bg-green-950/20',
    headerBg: 'bg-green-100/60 dark:bg-green-900/30',
    text: 'text-green-700 dark:text-green-300',
  },
  yellow: {
    border: 'border-yellow-400 dark:border-yellow-600',
    bg: 'bg-yellow-50/30 dark:bg-yellow-950/20',
    headerBg: 'bg-yellow-100/60 dark:bg-yellow-900/30',
    text: 'text-yellow-700 dark:text-yellow-300',
  },
  orange: {
    border: 'border-orange-400 dark:border-orange-600',
    bg: 'bg-orange-50/30 dark:bg-orange-950/20',
    headerBg: 'bg-orange-100/60 dark:bg-orange-900/30',
    text: 'text-orange-700 dark:text-orange-300',
  },
  red: {
    border: 'border-red-400 dark:border-red-600',
    bg: 'bg-red-50/30 dark:bg-red-950/20',
    headerBg: 'bg-red-100/60 dark:bg-red-900/30',
    text: 'text-red-700 dark:text-red-300',
  },
  purple: {
    border: 'border-purple-400 dark:border-purple-600',
    bg: 'bg-purple-50/30 dark:bg-purple-950/20',
    headerBg: 'bg-purple-100/60 dark:bg-purple-900/30',
    text: 'text-purple-700 dark:text-purple-300',
  },
  cyan: {
    border: 'border-cyan-400 dark:border-cyan-600',
    bg: 'bg-cyan-50/30 dark:bg-cyan-950/20',
    headerBg: 'bg-cyan-100/60 dark:bg-cyan-900/30',
    text: 'text-cyan-700 dark:text-cyan-300',
  },
}

function getPhaseColors(color?: string) {
  return phaseColors[color ?? 'gray'] ?? phaseColors.gray
}

/** Short label for revision scheme type */
function revisionSchemeLabel(phase: LifecyclePhaseConfig): string | null {
  const scheme = phase.revisionScheme
  if (!scheme) return null
  switch (scheme.type) {
    case 'alpha':
      return 'A, B, C'
    case 'numeric':
      return '1, 2, 3'
    case 'prefixed-numeric':
      return `${scheme.prefix}1, ${scheme.prefix}2`
    case 'none':
      return 'No Rev'
  }
}

function PhaseGroupNodeComponent({
  data,
  selected,
}: NodeProps<PhaseGroupNodeType>) {
  const { phase, onEdit, onDelete } = data
  const colors = getPhaseColors(phase.color)
  const revLabel = revisionSchemeLabel(phase)

  return (
    <div
      className={`
        group relative rounded-lg border-2 border-dashed
        ${colors.border} ${colors.bg}
        ${selected ? 'ring-2 ring-cyan-500 ring-offset-2 dark:ring-offset-slate-900' : ''}
        min-w-[220px] min-h-[120px] w-full h-full
      `}
      style={{ pointerEvents: 'all' }}
    >
      {/* Header bar */}
      <div
        className={`
          flex items-center justify-between px-3 py-1.5 rounded-t-md
          ${colors.headerBg}
        `}
      >
        <div className="flex items-center gap-1.5">
          <span className={`font-semibold text-xs ${colors.text}`}>
            {phase.name}
          </span>
          {phase.resetRevisionOnEntry && (
            <span
              className="text-amber-500 dark:text-amber-400"
              title="Resets revision on entry"
            >
              <RotateCcw className="h-3 w-3" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {revLabel && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/60 dark:bg-black/20 text-slate-600 dark:text-slate-400 font-mono">
              {revLabel}
            </span>
          )}
          {/* Action buttons - visible on hover */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            {onEdit && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(phase)
                }}
                className="p-0.5 rounded hover:bg-white/50 dark:hover:bg-black/20 text-slate-500 hover:text-cyan-600"
                title="Edit phase"
              >
                <Edit2 className="h-3 w-3" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(phase.id)
                }}
                className="p-0.5 rounded hover:bg-white/50 dark:hover:bg-black/20 text-slate-500 hover:text-red-600"
                title="Delete phase"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

export const PhaseGroupNode = memo(PhaseGroupNodeComponent)
