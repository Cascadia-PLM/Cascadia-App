import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'

/**
 * Data for the main branch HEAD marker node
 */
export interface MainHeadNodeData extends Record<string, unknown> {
  label: string
}

export type MainHeadNodeType = Node<MainHeadNodeData, 'mainHeadNode'>

/**
 * A simple visual marker representing the HEAD of the main branch.
 * This extends the main branch line upward to show where open ECOs
 * branch from.
 */
// Fixed width must match HEAD_NODE_WIDTH constant in graph views for proper alignment
const HEAD_NODE_WIDTH = 100

function MainHeadNodeComponent({ data }: NodeProps<MainHeadNodeType>) {
  return (
    <div
      className="
        flex items-center justify-center gap-2 py-1.5 rounded-full
        bg-green-100 dark:bg-green-900/40
        border-2 border-green-400 dark:border-green-600
        shadow-sm
      "
      style={{ width: HEAD_NODE_WIDTH }}
    >
      {/* Target handle at top - hidden, for potential future incoming edges */}
      <Handle
        type="target"
        position={Position.Top}
        className="!w-3 !h-3 !bg-green-500 dark:!bg-green-400 !border-2 !border-white dark:!border-slate-800 !opacity-0"
      />
      {/* Source handle at bottom - edge starts here and goes down to latest main commit */}
      <Handle
        type="source"
        position={Position.Bottom}
        className="!w-3 !h-3 !bg-green-500 dark:!bg-green-400 !border-2 !border-white dark:!border-slate-800"
      />

      <div className="w-2.5 h-2.5 rounded-full bg-green-500 dark:bg-green-400" />
      <span className="text-sm font-medium text-green-700 dark:text-green-300">
        {data.label}
      </span>
    </div>
  )
}

export const MainHeadNode = memo(MainHeadNodeComponent)
