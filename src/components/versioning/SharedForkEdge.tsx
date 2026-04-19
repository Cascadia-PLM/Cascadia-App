import { memo } from 'react'
import { BaseEdge } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

// Offset above the fork point for the shared horizontal line
const SHARED_LINE_OFFSET = 60

/**
 * Custom edge for ECOs sharing a fork point.
 * Creates a path that goes: vertical up from ECO, then horizontal to main column,
 * then vertical down to fork point. Multiple ECOs share the horizontal segment.
 */
function SharedForkEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  style,
  markerStart,
  markerEnd,
}: EdgeProps) {
  // Calculate the Y level for the shared horizontal line
  // Add offset above the fork point to create more space
  const sharedY = targetY - SHARED_LINE_OFFSET

  // Create path: from source (ECO) down to shared Y, then horizontal to target X, then down to target
  const path = `
    M ${sourceX} ${sourceY}
    L ${sourceX} ${sharedY}
    L ${targetX} ${sharedY}
    L ${targetX} ${targetY}
  `

  return (
    <BaseEdge
      id={id}
      path={path}
      style={style}
      markerStart={markerStart}
      markerEnd={markerEnd}
    />
  )
}

export const SharedForkEdge = memo(SharedForkEdgeComponent)
