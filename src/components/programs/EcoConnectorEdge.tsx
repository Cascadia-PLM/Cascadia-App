import { getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

interface EcoConnectorData {
  edgeType: 'eco-connector'
  ecoId: string
  ecoNumber: string
  sourceDesignId: string
  sourceDesignCode: string
  targetDesignId: string
  targetDesignCode: string
}

/**
 * Custom ReactFlow edge component for visualizing cross-design ECO connections.
 * Draws a dashed orange curved line between ECO branches across different design columns,
 * with the ECO number label at the midpoint.
 */
export function EcoConnectorEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps) {
  // Cast data to our expected type
  const edgeData = data as EcoConnectorData | undefined

  // Use a bezier path that curves above the connection points
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.5,
  })

  return (
    <>
      {/* Glow effect for better visibility */}
      <path
        id={`${id}-glow`}
        className="react-flow__edge-path"
        d={edgePath}
        style={{
          stroke: '#f97316',
          strokeWidth: 6,
          strokeOpacity: 0.2,
          fill: 'none',
        }}
      />

      {/* Main connector line */}
      <path
        id={id}
        className="react-flow__edge-path"
        d={edgePath}
        style={{
          stroke: '#f97316',
          strokeWidth: 3,
          strokeDasharray: '8,4',
          fill: 'none',
        }}
      />

      {/* ECO label background */}
      <rect
        x={labelX - 40}
        y={labelY - 10}
        width={80}
        height={20}
        rx={4}
        fill="white"
        className="dark:fill-slate-800"
        stroke="#f97316"
        strokeWidth={1}
      />

      {/* ECO label text */}
      <text
        x={labelX}
        y={labelY + 4}
        textAnchor="middle"
        className="text-xs font-medium fill-orange-600 dark:fill-orange-400"
        style={{ pointerEvents: 'none' }}
      >
        {edgeData?.ecoNumber || 'ECO'}
      </text>
    </>
  )
}
