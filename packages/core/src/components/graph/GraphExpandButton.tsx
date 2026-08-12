// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ChevronDown, ChevronUp, Loader2, Plus } from 'lucide-react'

export type ExpandDirection = 'expanded' | 'collapsed' | 'leaf'

export interface NodeExpandState {
  upstream: ExpandDirection
  downstream: ExpandDirection
}

/**
 * Per-direction expand/collapse button rendered above/below a graph node.
 * Shared by GraphItemNode (item relationship graphs) and GraphScopeNode
 * (program/design scope graphs).
 */
export function GraphExpandButton({
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
        hover:border-cyan-500 hover:text-cyan-600 dark:hover:text-cyan-400
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
