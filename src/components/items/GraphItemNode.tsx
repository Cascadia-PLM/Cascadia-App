import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, Loader2, Plus } from 'lucide-react'

type ExpandDirection = 'expanded' | 'collapsed' | 'leaf'

interface GraphItemNodeProps {
  data: {
    itemId: string
    itemNumber: string
    revision: string
    itemType: string
    name: string
    state: string
    level: number
    // Definition/Usage pattern fields
    isDefinition: boolean
    isUsage: boolean
    usageCount?: number
    definitionItemNumber?: string
    isCrossDesign?: boolean
    designCodes?: Array<string>
    // Expand/collapse state
    expandState?: {
      upstream: ExpandDirection
      downstream: ExpandDirection
    }
    expandingDirection?: 'upstream' | 'downstream' | null
    onExpand?: (nodeId: string, direction: 'upstream' | 'downstream') => void
    onCollapse?: (nodeId: string, direction: 'upstream' | 'downstream') => void
  }
}

function ExpandCollapseButton({
  direction,
  state,
  isExpanding,
  onClick,
}: {
  direction: 'upstream' | 'downstream'
  state: ExpandDirection
  isExpanding: boolean
  onClick: () => void
}) {
  if (state === 'leaf') return null

  const isTop = direction === 'upstream'
  const isExpanded = state === 'expanded'

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      disabled={isExpanding}
      className={`
        nopan nodrag absolute z-10
        flex items-center justify-center
        w-5 h-5 rounded-full
        border border-slate-300 dark:border-slate-600
        bg-white dark:bg-slate-800
        text-slate-500 dark:text-slate-400
        hover:bg-slate-100 dark:hover:bg-slate-700
        hover:border-cyan-500 hover:text-cyan-600
        transition-all shadow-sm
        disabled:opacity-50 disabled:cursor-not-allowed
        ${isTop ? '-top-3 left-1/2 -translate-x-1/2' : '-bottom-3 left-1/2 -translate-x-1/2'}
      `}
      title={isExpanded ? `Collapse ${direction}` : `Expand ${direction}`}
    >
      {isExpanding ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : isExpanded ? (
        isTop ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )
      ) : (
        <Plus className="h-3 w-3" />
      )}
    </button>
  )
}

export const GraphItemNode = memo(({ data }: GraphItemNodeProps) => {
  const {
    itemId,
    itemNumber,
    revision,
    itemType,
    name,
    state,
    level,
    isCrossDesign,
    designCodes,
    expandState,
    expandingDirection,
    onExpand,
    onCollapse,
  } = data

  // Color coding by level
  const levelColors = {
    0: 'bg-cyan-100 dark:bg-cyan-900 border-cyan-500', // Center item
    1: 'bg-slate-100 dark:bg-slate-800 border-slate-400', // Direct relations
    2: 'bg-slate-50 dark:bg-slate-900 border-slate-300', // Second-level
  }

  const stateColors: Record<string, string> = {
    Draft: 'bg-slate-200 text-slate-700',
    InReview: 'bg-blue-200 text-blue-700',
    Approved: 'bg-green-200 text-green-700',
    Released: 'bg-green-300 text-green-800',
    Obsolete: 'bg-red-200 text-red-700',
    Concept: 'bg-slate-200 text-slate-700',
    Planning: 'bg-blue-200 text-blue-700',
    Closed: 'bg-green-200 text-green-700',
    Cancelled: 'bg-red-200 text-red-700',
  }

  const typeColors: Record<string, string> = {
    Part: 'bg-blue-100 text-blue-700',
    Document: 'bg-purple-100 text-purple-700',
    ChangeOrder: 'bg-orange-100 text-orange-700',
    Project: 'bg-teal-100 text-teal-700',
  }

  // Determine route based on item type
  const getItemRoute = () => {
    const typeRoutes: Record<string, string> = {
      Part: '/parts',
      Document: '/documents',
      ChangeOrder: '/change-orders',
      Project: '/projects',
    }
    return `${typeRoutes[itemType] || '/items'}/${itemId}`
  }

  const baseLevelClass =
    levelColors[level as keyof typeof levelColors] || levelColors[2]

  const handleUpstreamClick = () => {
    if (!expandState) return
    if (expandState.upstream === 'expanded') {
      onCollapse?.(itemId, 'upstream')
    } else {
      onExpand?.(itemId, 'upstream')
    }
  }

  const handleDownstreamClick = () => {
    if (!expandState) return
    if (expandState.downstream === 'expanded') {
      onCollapse?.(itemId, 'downstream')
    } else {
      onExpand?.(itemId, 'downstream')
    }
  }

  return (
    <div className="relative">
      {/* Upstream expand/collapse button */}
      {expandState && onExpand && onCollapse && (
        <ExpandCollapseButton
          direction="upstream"
          state={expandState.upstream}
          isExpanding={expandingDirection === 'upstream'}
          onClick={handleUpstreamClick}
        />
      )}

      <div
        className={`
          px-4 py-3 rounded-lg border-2 shadow-md min-w-[200px] max-w-[280px]
          ${baseLevelClass}
          ${isCrossDesign ? 'ring-2 ring-offset-1 ring-amber-400' : ''}
          transition-all hover:shadow-lg
        `}
      >
        {/* Handles for connections */}
        <Handle
          type="target"
          position={Position.Top}
          className="!bg-slate-400"
        />
        <Handle
          type="source"
          position={Position.Bottom}
          className="!bg-slate-400"
        />
        <Handle
          type="target"
          position={Position.Left}
          className="!bg-slate-400"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!bg-slate-400"
        />

        {/* Item header */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <Link
            to={getItemRoute()}
            className="font-semibold text-sm text-slate-900 dark:text-white hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
          >
            {itemNumber}
          </Link>
          <span className="text-xs px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300">
            {revision}
          </span>
        </div>

        {/* Item name */}
        {name && (
          <div className="text-xs text-slate-600 dark:text-slate-400 mb-2 line-clamp-2">
            {name}
          </div>
        )}

        {/* Badges */}
        <div className="flex flex-wrap gap-1">
          <span
            className={`text-xs px-2 py-0.5 rounded ${typeColors[itemType] || 'bg-gray-100 text-gray-700'}`}
          >
            {itemType}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded ${stateColors[state] || 'bg-gray-200 text-gray-700'}`}
          >
            {state}
          </span>
          {/* Cross-design indicator */}
          {isCrossDesign && designCodes && designCodes.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              Design: {designCodes.join(', ')}
            </span>
          )}
        </div>

        {/* Level indicator (for debugging, can be removed) */}
        {level === 0 && (
          <div className="mt-2 text-xs font-semibold text-cyan-600 dark:text-cyan-400">
            Current Item
          </div>
        )}
      </div>

      {/* Downstream expand/collapse button */}
      {expandState && onExpand && onCollapse && (
        <ExpandCollapseButton
          direction="downstream"
          state={expandState.downstream}
          isExpanding={expandingDirection === 'downstream'}
          onClick={handleDownstreamClick}
        />
      )}
    </div>
  )
})

GraphItemNode.displayName = 'GraphItemNode'
