import { memo, useCallback, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  useReactFlow,
} from '@xyflow/react'
import { Edit2, GripVertical, ShieldCheck, Zap } from 'lucide-react'
import type { Edge, EdgeProps } from '@xyflow/react'
import type { WorkflowTransition } from '@/lib/workflows/types'

interface TransitionEdgeData extends Record<string, unknown> {
  transition: WorkflowTransition
  isSelected?: boolean
  onEdit?: (transition: WorkflowTransition) => void
  onDelete?: (transitionId: string) => void
  onLabelPositionChange?: (
    transitionId: string,
    position: { x: number; y: number } | undefined,
  ) => void
  definitionType?: 'lifecycle' | 'workflow'
  readOnly?: boolean
  /** Whether this edge crosses a phase boundary */
  isCrossPhase?: boolean
}

export type TransitionEdgeType = Edge<TransitionEdgeData, 'transitionEdge'>

/**
 * Creates an SVG path that routes through a waypoint (label position).
 * Uses quadratic bezier curves to create a smooth path through the waypoint.
 */
function getPathThroughWaypoint(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  waypointX: number,
  waypointY: number,
): string {
  // Calculate control points for smooth curves through the waypoint
  // We use two quadratic bezier curves meeting at the waypoint

  // First curve: source to waypoint
  // Control point is offset from the midpoint between source and waypoint
  const mid1X = (sourceX + waypointX) / 2

  // Second curve: waypoint to target
  // Control point is offset from the midpoint between waypoint and target
  const mid2X = (waypointX + targetX) / 2

  // Create smooth curve using cubic beziers
  // Source → waypoint → target
  return `M ${sourceX},${sourceY} Q ${mid1X},${sourceY} ${waypointX},${waypointY} Q ${mid2X},${targetY} ${targetX},${targetY}`
}

function TransitionEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
  markerEnd,
}: EdgeProps<TransitionEdgeType>) {
  const { screenToFlowPosition } = useReactFlow()
  const [isDragging, setIsDragging] = useState(false)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)
  const labelRef = useRef<HTMLDivElement>(null)

  const transition = data?.transition
  const hasGuards = transition?.guards && transition.guards.length > 0
  const hasActions = transition?.actions && transition.actions.length > 0
  const hasApproval = transition?.approvalRequirement
  const labelPosition = transition?.labelPosition
  const readOnly = data?.readOnly
  const isCrossPhase = data?.isCrossPhase

  // Calculate path and label position
  let edgePath: string
  let labelX: number
  let labelY: number

  if (labelPosition) {
    // Use custom path through the waypoint
    edgePath = getPathThroughWaypoint(
      sourceX,
      sourceY,
      targetX,
      targetY,
      labelPosition.x,
      labelPosition.y,
    )
    labelX = labelPosition.x
    labelY = labelPosition.y
  } else {
    // Use standard bezier path
    const [path, lx, ly] = getBezierPath({
      sourceX,
      sourceY,
      sourcePosition,
      targetX,
      targetY,
      targetPosition,
    })
    edgePath = path
    labelX = lx
    labelY = ly
  }

  // Handle drag start
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly || !data?.onLabelPositionChange) return
      e.preventDefault()
      e.stopPropagation()

      setIsDragging(true)
      dragStartPos.current = { x: e.clientX, y: e.clientY }

      // Add document-level mouse event handlers
      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStartPos.current) return

        const flowPosition = screenToFlowPosition({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        })

        data.onLabelPositionChange?.(id, flowPosition)
      }

      const handleMouseUp = () => {
        setIsDragging(false)
        dragStartPos.current = null
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [id, readOnly, data, screenToFlowPosition],
  )

  // Handle double-click to reset position
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly || !data?.onLabelPositionChange) return
      e.preventDefault()
      e.stopPropagation()

      // Reset to automatic positioning
      data.onLabelPositionChange(id, undefined)
    },
    [id, readOnly, data],
  )

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          strokeWidth: selected ? 3 : isCrossPhase ? 2.5 : 2,
          stroke: selected ? '#0ea5e9' : isCrossPhase ? '#f59e0b' : '#94a3b8',
          strokeDasharray: isCrossPhase ? '8,4' : undefined,
        }}
      />
      <EdgeLabelRenderer>
        <div
          ref={labelRef}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
          onMouseDown={handleMouseDown}
          onPointerDown={(e) => {
            // Capture pointer events to prevent React Flow from panning
            if (!readOnly && data?.onLabelPositionChange) {
              e.stopPropagation()
            }
          }}
          onDoubleClick={handleDoubleClick}
        >
          <div
            className={`
              group relative flex items-center gap-1 px-3 py-1.5 rounded-md
              bg-white dark:bg-slate-800 border shadow-sm
              transition-all duration-200 nodrag nopan
              ${
                selected
                  ? 'border-cyan-500 ring-2 ring-cyan-500/20'
                  : 'border-slate-300 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600'
              }
              ${isDragging ? 'ring-2 ring-cyan-500/40 shadow-lg cursor-grabbing' : ''}
              ${!readOnly && data?.onLabelPositionChange ? 'cursor-grab' : ''}
            `}
            title={
              !readOnly && data?.onLabelPositionChange
                ? 'Drag to reposition • Double-click to reset'
                : undefined
            }
          >
            {/* Drag handle indicator */}
            {!readOnly && data?.onLabelPositionChange && (
              <div className="opacity-0 group-hover:opacity-50 transition-opacity -ml-1">
                <GripVertical className="h-3 w-3 text-slate-400" />
              </div>
            )}

            {/* Main content */}
            <div className="flex flex-col items-center gap-1">
              {/* Transition name */}
              <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
                {transition?.name || 'Transition'}
              </span>

              {/* Indicators for guards/actions */}
              {(hasGuards || hasActions || hasApproval) && (
                <div className="flex items-center gap-1.5">
                  {hasGuards && (
                    <span
                      className="flex items-center gap-0.5 text-[10px] text-amber-600 dark:text-amber-400"
                      title={`${transition.guards?.length} guard(s)`}
                    >
                      <ShieldCheck className="h-3 w-3" />
                      {transition.guards?.length}
                    </span>
                  )}
                  {hasActions && (
                    <span
                      className="flex items-center gap-0.5 text-[10px] text-purple-600 dark:text-purple-400"
                      title={`${transition.actions?.length} action(s)`}
                    >
                      <Zap className="h-3 w-3" />
                      {transition.actions?.length}
                    </span>
                  )}
                  {hasApproval && (
                    <span
                      className="text-[10px] text-green-600 dark:text-green-400"
                      title={`${transition.approvalRequirement?.requiredCount} approval(s) required`}
                    >
                      {transition.approvalRequirement?.requiredCount}+
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Custom position indicator */}
            {labelPosition && !readOnly && (
              <div
                className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-cyan-500 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Custom position (double-click label to reset)"
              />
            )}

            {/* Edit button on hover */}
            {data?.onEdit && transition && !readOnly && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  data.onEdit?.(transition)
                }}
                className="absolute -right-2 -top-2 p-1 rounded-full bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 shadow-sm opacity-0 group-hover:opacity-100 transition-opacity hover:bg-cyan-50 dark:hover:bg-cyan-900/30"
                title="Edit transition"
              >
                <Edit2 className="h-3 w-3 text-slate-500 dark:text-slate-400" />
              </button>
            )}
          </div>
        </div>
      </EdgeLabelRenderer>
    </>
  )
}

export const TransitionEdge = memo(TransitionEdgeComponent)
