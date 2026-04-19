import { memo } from 'react'
import { Link } from '@tanstack/react-router'
import { Box } from 'lucide-react'
import type { NodeProps } from '@xyflow/react'

export interface DesignHeaderNodeData {
  designId: string
  designCode: string
  designName: string
  width: number
}

/**
 * ReactFlow node component for design column headers.
 * Rendered as a node so it pans/zooms with the graph.
 */
export const DesignHeaderNode = memo(function DesignHeaderNode({
  data,
}: NodeProps) {
  const { designId, designCode, designName, width } =
    data as unknown as DesignHeaderNodeData

  return (
    <div
      className="flex flex-col items-center justify-center p-3 bg-white/95 dark:bg-slate-900/95 backdrop-blur-sm rounded-lg border border-slate-300 dark:border-slate-600 shadow-sm"
      style={{ width, minWidth: 200 }}
    >
      <Link
        to="/designs/$id"
        params={{ id: designId }}
        className="flex items-center gap-2 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      >
        <Box className="h-5 w-5 text-blue-500 dark:text-blue-400" />
        <span className="font-bold text-base text-slate-900 dark:text-white">
          {designCode}
        </span>
      </Link>
      <span className="text-sm text-slate-500 dark:text-slate-400 truncate max-w-full mt-1">
        {designName}
      </span>
    </div>
  )
})
