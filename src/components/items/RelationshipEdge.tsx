import { memo, useCallback, useRef, useState } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useReactFlow,
} from '@xyflow/react'
import { GripVertical } from 'lucide-react'
import type { Edge, EdgeProps } from '@xyflow/react'

export interface RelationshipEdgeData extends Record<string, unknown> {
  parallelOffset?: number
  waypoint?: { x: number; y: number }
  onWaypointChange?: (
    edgeId: string,
    waypoint: { x: number; y: number } | undefined,
  ) => void
  isUsageRelationship?: boolean
  relationshipType?: string
}

export type RelationshipEdgeType = Edge<
  RelationshipEdgeData,
  'relationshipEdge'
>

/**
 * Creates an SVG path that routes through a waypoint using quadratic bezier curves.
 * Reuses the pattern from TransitionEdge.tsx.
 */
function getPathThroughWaypoint(
  sourceX: number,
  sourceY: number,
  targetX: number,
  targetY: number,
  waypointX: number,
  waypointY: number,
): string {
  const mid1X = (sourceX + waypointX) / 2
  const mid2X = (waypointX + targetX) / 2
  return `M ${sourceX},${sourceY} Q ${mid1X},${sourceY} ${waypointX},${waypointY} Q ${mid2X},${targetY} ${targetX},${targetY}`
}

function RelationshipEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
  markerEnd,
  label,
}: EdgeProps<RelationshipEdgeType>) {
  const { screenToFlowPosition } = useReactFlow()
  const [isDragging, setIsDragging] = useState(false)
  const dragStartPos = useRef<{ x: number; y: number } | null>(null)

  const parallelOffset = data?.parallelOffset ?? 0
  const userWaypoint = data?.waypoint
  const isUsage = data?.isUsageRelationship === true

  // Compute default smooth step path
  const [defaultPath, defaultLabelX, defaultLabelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 8,
  })

  let edgePath: string
  let labelX: number
  let labelY: number

  if (userWaypoint) {
    // User-dragged position takes priority
    edgePath = getPathThroughWaypoint(
      sourceX,
      sourceY,
      targetX,
      targetY,
      userWaypoint.x,
      userWaypoint.y,
    )
    labelX = userWaypoint.x
    labelY = userWaypoint.y
  } else if (parallelOffset !== 0) {
    // Auto-offset for parallel edges between same node pair
    const offsetX = defaultLabelX + parallelOffset
    const offsetY = defaultLabelY
    edgePath = getPathThroughWaypoint(
      sourceX,
      sourceY,
      targetX,
      targetY,
      offsetX,
      offsetY,
    )
    labelX = offsetX
    labelY = offsetY
  } else {
    // Default smooth step path
    edgePath = defaultPath
    labelX = defaultLabelX
    labelY = defaultLabelY
  }

  // Drag to reposition label + reroute edge
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!data?.onWaypointChange) return
      e.preventDefault()
      e.stopPropagation()

      setIsDragging(true)
      dragStartPos.current = { x: e.clientX, y: e.clientY }

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const flowPos = screenToFlowPosition({
          x: moveEvent.clientX,
          y: moveEvent.clientY,
        })
        data.onWaypointChange?.(id, flowPos)
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
    [id, data, screenToFlowPosition],
  )

  // Double-click to reset to auto position
  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!data?.onWaypointChange) return
      e.preventDefault()
      e.stopPropagation()
      data.onWaypointChange(id, undefined)
    },
    [id, data],
  )

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            className="nodrag nopan"
            onMouseDown={handleMouseDown}
            onPointerDown={(e) => {
              if (data?.onWaypointChange) e.stopPropagation()
            }}
            onDoubleClick={handleDoubleClick}
          >
            <div
              className={`
                group relative flex items-center gap-1 px-2 py-1 rounded text-xs font-semibold
                bg-white dark:bg-slate-800 border shadow-sm
                transition-all duration-150
                ${isDragging ? 'ring-2 ring-cyan-500/40 shadow-lg cursor-grabbing' : ''}
                ${data?.onWaypointChange && !isDragging ? 'cursor-grab hover:shadow-md' : ''}
                ${
                  isUsage
                    ? 'border-purple-300 dark:border-purple-700 text-purple-600 dark:text-purple-400'
                    : 'border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-300'
                }
              `}
              title={
                data?.onWaypointChange
                  ? 'Drag to reposition \u2022 Double-click to reset'
                  : undefined
              }
            >
              {data?.onWaypointChange && (
                <div className="opacity-0 group-hover:opacity-50 transition-opacity -ml-0.5">
                  <GripVertical className="h-3 w-3 text-slate-400" />
                </div>
              )}
              <span>{label}</span>
              {userWaypoint && (
                <div className="absolute -top-1 -left-1 w-2 h-2 rounded-full bg-cyan-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </div>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

export const RelationshipEdge = memo(RelationshipEdgeComponent)
