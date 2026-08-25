// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import type { ExpandDirection } from '@/components/graph/GraphExpandButton'
import { GraphExpandButton } from '@/components/graph/GraphExpandButton'
import { useLifecycleState } from '@/components/items/StateBadge'
import { getItemDetailPath } from '@/lib/items/item-type-ui'

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

  const stateStyle = useLifecycleState(itemType, state)

  // Color coding by level
  const levelColors = {
    0: 'bg-cyan-100 dark:bg-cyan-900 border-cyan-500', // Center item
    1: 'bg-slate-100 dark:bg-slate-800 border-slate-400', // Direct relations
    2: 'bg-slate-50 dark:bg-slate-900 border-slate-300 dark:border-slate-700', // Second-level
  }

  const typeColors: Record<string, string> = {
    Part: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300',
    Document:
      'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300',
    ChangeOrder:
      'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300',
    WorkOrder:
      'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300',
    PhysicalPart:
      'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
  }

  const baseLevelClass =
    levelColors[level as keyof typeof levelColors] || levelColors[2]
  // null when no detail page exists for the type
  const itemRoute = getItemDetailPath(itemType, itemId)

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
        <GraphExpandButton
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
          {itemRoute ? (
            <Link
              to={itemRoute}
              className="font-semibold text-sm text-slate-900 dark:text-white hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
            >
              {itemNumber}
            </Link>
          ) : (
            <span className="font-semibold text-sm text-slate-900 dark:text-white">
              {itemNumber}
            </span>
          )}
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
            className={`text-xs px-2 py-0.5 rounded ${typeColors[itemType] || 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
          >
            {itemType}
          </span>
          <span
            className={`text-xs px-2 py-0.5 rounded ${stateStyle.className}`}
          >
            {stateStyle.label}
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
        <GraphExpandButton
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
