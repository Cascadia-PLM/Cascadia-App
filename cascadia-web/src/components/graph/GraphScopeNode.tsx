// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import { Box, FolderKanban } from 'lucide-react'
import { GraphExpandButton } from './GraphExpandButton'
import type { NodeExpandState } from './GraphExpandButton'

export type ScopeNodeKind = 'program' | 'design'

interface GraphScopeNodeProps {
  data: {
    kind: ScopeNodeKind
    entityId: string
    code: string
    name: string
    /** Program status ('Active', …) or design type ('Engineering', …) */
    subtype: string
    level: number
    // Expand/collapse state (injected by ScopeGraphView)
    expandState?: NodeExpandState
    expandingDirection?: 'upstream' | 'downstream' | null
    onExpand?: (nodeId: string, direction: 'upstream' | 'downstream') => void
    onCollapse?: (nodeId: string, direction: 'upstream' | 'downstream') => void
  }
}

/**
 * React Flow node for Program and Design nodes in the scope graph
 * (Program → Design → Item drill-down). Item nodes in the same graph render
 * with GraphItemNode; this component covers the two container kinds.
 */
export const GraphScopeNode = memo(({ data }: GraphScopeNodeProps) => {
  const {
    kind,
    entityId,
    code,
    name,
    subtype,
    expandState,
    expandingDirection,
    onExpand,
    onCollapse,
  } = data

  // Node id used in the graph caches: `program:<uuid>` / `design:<uuid>`
  const nodeId = `${kind}:${entityId}`

  const isProgram = kind === 'program'
  const containerClass = isProgram
    ? 'bg-indigo-100 dark:bg-indigo-950 border-indigo-500'
    : 'bg-violet-100 dark:bg-violet-950 border-violet-500'
  const kindBadgeClass = isProgram
    ? 'bg-indigo-200 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300'
    : 'bg-violet-200 text-violet-800 dark:bg-violet-900 dark:text-violet-300'
  const route = isProgram ? `/programs/${entityId}` : `/designs/${entityId}`
  const Icon = isProgram ? FolderKanban : Box

  const handleUpstreamClick = () => {
    if (!expandState) return
    if (expandState.upstream === 'expanded') {
      onCollapse?.(nodeId, 'upstream')
    } else {
      onExpand?.(nodeId, 'upstream')
    }
  }

  const handleDownstreamClick = () => {
    if (!expandState) return
    if (expandState.downstream === 'expanded') {
      onCollapse?.(nodeId, 'downstream')
    } else {
      onExpand?.(nodeId, 'downstream')
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
          ${containerClass}
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

        {/* Header: icon + code */}
        <div className="flex items-center gap-2 mb-2">
          <Icon className="h-4 w-4 shrink-0 text-slate-600 dark:text-slate-300" />
          <Link
            to={route}
            className="font-semibold text-sm text-slate-900 dark:text-white hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
          >
            {code}
          </Link>
        </div>

        {/* Name */}
        {name && (
          <div className="text-xs text-slate-600 dark:text-slate-400 mb-2 line-clamp-2">
            {name}
          </div>
        )}

        {/* Badges */}
        <div className="flex flex-wrap gap-1">
          <span className={`text-xs px-2 py-0.5 rounded ${kindBadgeClass}`}>
            {isProgram ? 'Program' : 'Design'}
          </span>
          <span className="text-xs px-2 py-0.5 rounded bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-300">
            {subtype}
          </span>
        </div>
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

GraphScopeNode.displayName = 'GraphScopeNode'
