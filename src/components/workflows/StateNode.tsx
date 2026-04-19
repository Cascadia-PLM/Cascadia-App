import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Circle, Edit2, Flag, Play, Trash2 } from 'lucide-react'
import type { Node, NodeProps } from '@xyflow/react'
import type { WorkflowState } from '@/lib/workflows/types'

interface StateNodeData extends Record<string, unknown> {
  state: WorkflowState
  isSelected?: boolean
  onEdit?: (state: WorkflowState) => void
  onDelete?: (stateId: string) => void
  /** Hide connection handles (for Driven lifecycles) */
  hideHandles?: boolean
}

export type StateNodeType = Node<StateNodeData, 'stateNode'>

const stateColors: Record<
  string,
  { bg: string; border: string; text: string }
> = {
  gray: {
    bg: 'bg-slate-100 dark:bg-slate-800',
    border: 'border-slate-300 dark:border-slate-600',
    text: 'text-slate-700 dark:text-slate-300',
  },
  blue: {
    bg: 'bg-blue-100 dark:bg-blue-900/50',
    border: 'border-blue-300 dark:border-blue-700',
    text: 'text-blue-700 dark:text-blue-300',
  },
  green: {
    bg: 'bg-green-100 dark:bg-green-900/50',
    border: 'border-green-300 dark:border-green-700',
    text: 'text-green-700 dark:text-green-300',
  },
  yellow: {
    bg: 'bg-yellow-100 dark:bg-yellow-900/50',
    border: 'border-yellow-300 dark:border-yellow-700',
    text: 'text-yellow-700 dark:text-yellow-300',
  },
  orange: {
    bg: 'bg-orange-100 dark:bg-orange-900/50',
    border: 'border-orange-300 dark:border-orange-700',
    text: 'text-orange-700 dark:text-orange-300',
  },
  red: {
    bg: 'bg-red-100 dark:bg-red-900/50',
    border: 'border-red-300 dark:border-red-700',
    text: 'text-red-700 dark:text-red-300',
  },
  purple: {
    bg: 'bg-purple-100 dark:bg-purple-900/50',
    border: 'border-purple-300 dark:border-purple-700',
    text: 'text-purple-700 dark:text-purple-300',
  },
  cyan: {
    bg: 'bg-cyan-100 dark:bg-cyan-900/50',
    border: 'border-cyan-300 dark:border-cyan-700',
    text: 'text-cyan-700 dark:text-cyan-300',
  },
}

function getColorClasses(color?: string) {
  // Handle hex colors or named colors
  if (color?.startsWith('#')) {
    // Map common hex colors to names
    const hexToName: Record<string, string> = {
      '#gray': 'gray',
      '#blue': 'blue',
      '#green': 'green',
      '#yellow': 'yellow',
      '#orange': 'orange',
      '#red': 'red',
      '#purple': 'purple',
      '#cyan': 'cyan',
    }
    color = hexToName[color] || 'gray'
  }
  return stateColors[color ?? 'gray'] ?? stateColors.gray
}

function StateNodeComponent({ data, selected }: NodeProps<StateNodeType>) {
  const { state, onEdit, onDelete, hideHandles } = data
  const colors = getColorClasses(state.color)

  return (
    <div
      className={`
        relative min-w-[160px] max-w-[200px] rounded-lg border-2 shadow-sm
        transition-all duration-200
        ${colors.bg} ${colors.border}
        ${selected ? 'ring-2 ring-cyan-500 ring-offset-2 dark:ring-offset-slate-900' : ''}
      `}
    >
      {/* Connection handles (hidden for Driven lifecycles) */}
      {!hideHandles && (
        <>
          <Handle
            type="target"
            position={Position.Top}
            className="!w-3 !h-3 !bg-slate-400 dark:!bg-slate-500 !border-2 !border-white dark:!border-slate-800"
          />
          <Handle
            type="source"
            position={Position.Bottom}
            className="!w-3 !h-3 !bg-slate-400 dark:!bg-slate-500 !border-2 !border-white dark:!border-slate-800"
          />
        </>
      )}

      {/* State content */}
      <div className="p-3">
        {/* Header with state type indicators */}
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-1">
            {state.isInitial && (
              <span
                className="text-green-600 dark:text-green-400"
                title="Initial State"
              >
                <Play className="h-3 w-3" />
              </span>
            )}
            {state.isFinal && (
              <span
                className="text-red-600 dark:text-red-400"
                title="Final State"
              >
                <Flag className="h-3 w-3" />
              </span>
            )}
            {!state.isInitial && !state.isFinal && (
              <Circle className={`h-3 w-3 ${colors.text}`} />
            )}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {onEdit && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(state)
                }}
                className="p-1 rounded hover:bg-white/50 dark:hover:bg-black/20 text-slate-500 hover:text-cyan-600"
                title="Edit state"
              >
                <Edit2 className="h-3 w-3" />
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onDelete(state.id)
                }}
                className="p-1 rounded hover:bg-white/50 dark:hover:bg-black/20 text-slate-500 hover:text-red-600"
                title="Delete state"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>

        {/* State name */}
        <h3 className={`font-semibold text-sm ${colors.text}`}>{state.name}</h3>

        {/* Description */}
        {state.description && (
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 line-clamp-2">
            {state.description}
          </p>
        )}
      </div>
    </div>
  )
}

export const StateNode = memo(StateNodeComponent)
