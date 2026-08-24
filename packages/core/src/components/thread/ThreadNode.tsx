// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Link } from '@tanstack/react-router'
import {
  Box,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Factory,
  FileText,
  ListChecks,
  Package,
  Plus,
  Settings,
  Wrench,
} from 'lucide-react'
import {
  THREAD_HANDLE_SOURCE,
  THREAD_HANDLE_SOURCE_ALT,
  THREAD_HANDLE_TARGET,
  THREAD_HANDLE_TARGET_ALT,
} from './swimLaneLayout'
import type { Node, NodeProps } from '@xyflow/react'
import type { LucideIcon } from 'lucide-react'
import type { ThreadNode as ThreadNodeData } from '@/lib/services/ThreadService'
import { useLifecycleState } from '@/components/items/StateBadge'

/** Opposite side of a handle position (Top↔Bottom, Left↔Right). */
export function flipPosition(position: Position): Position {
  switch (position) {
    case Position.Top:
      return Position.Bottom
    case Position.Bottom:
      return Position.Top
    case Position.Left:
      return Position.Right
    case Position.Right:
      return Position.Left
  }
}

type ThreadNodeProps = NodeProps<Node>

/** Expand/collapse display state of one direction of a thread node. */
export type ThreadExpandState = 'expanded' | 'collapsed' | 'leaf'

/**
 * Optional expand/collapse fields injected into node data by
 * DigitalThreadNavigator. Absent (e.g. in the comparison dialog's
 * ThreadNodeDiff flow) the node renders without toggle buttons.
 */
export interface ThreadNodeExpandData {
  expandState?: { up: ThreadExpandState; down: ThreadExpandState }
  isHorizontal?: boolean
  onToggleExpand?: (nodeId: string, direction: 'up' | 'down') => void
}

function ThreadExpandButton({
  direction,
  state,
  isHorizontal,
  onClick,
}: {
  direction: 'up' | 'down'
  state: ThreadExpandState
  isHorizontal: boolean
  onClick: () => void
}) {
  if (state === 'leaf') return null

  const isExpanded = state === 'expanded'
  const placement =
    direction === 'up'
      ? isHorizontal
        ? '-left-3 top-1/2 -translate-y-1/2'
        : '-top-3 left-1/2 -translate-x-1/2'
      : isHorizontal
        ? '-right-3 top-1/2 -translate-y-1/2'
        : '-bottom-3 left-1/2 -translate-x-1/2'
  const ExpandedIcon =
    direction === 'up'
      ? isHorizontal
        ? ChevronLeft
        : ChevronUp
      : isHorizontal
        ? ChevronRight
        : ChevronDown

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
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
        ${placement}
      `}
      title={
        isExpanded ? `Collapse ${direction}stream` : `Expand ${direction}stream`
      }
    >
      {isExpanded ? (
        <ExpandedIcon className="h-3 w-3" />
      ) : (
        <Plus className="h-3 w-3" />
      )}
    </button>
  )
}

const itemTypeIcons: Record<string, LucideIcon> = {
  Part: Box,
  Document: FileText,
  ChangeOrder: Settings,
  Requirement: ListChecks,
  Task: ListChecks,
  WorkOrder: Factory,
  PhysicalPart: Package,
}

interface DomainColors {
  bg: string
  border: string
  header: string
  text: string
  badge: string
}

/** Fallback palette for unrecognized domains. */
const engineeringColors: DomainColors = {
  bg: 'bg-blue-50 dark:bg-blue-950',
  border: 'border-blue-300 dark:border-blue-700',
  header: 'bg-blue-100 dark:bg-blue-900',
  text: 'text-blue-700 dark:text-blue-300',
  badge: 'bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-300',
}

const domainColors: Record<string, DomainColors> = {
  requirements: {
    bg: 'bg-purple-50 dark:bg-purple-950',
    border: 'border-purple-300 dark:border-purple-700',
    header: 'bg-purple-100 dark:bg-purple-900',
    text: 'text-purple-700 dark:text-purple-300',
    badge:
      'bg-purple-100 dark:bg-purple-800 text-purple-700 dark:text-purple-300',
  },
  engineering: engineeringColors,
  manufacturing: {
    bg: 'bg-amber-50 dark:bg-amber-950',
    border: 'border-amber-300 dark:border-amber-700',
    header: 'bg-amber-100 dark:bg-amber-900',
    text: 'text-amber-700 dark:text-amber-300',
    badge: 'bg-amber-100 dark:bg-amber-800 text-amber-700 dark:text-amber-300',
  },
  validation: {
    bg: 'bg-teal-50 dark:bg-teal-950',
    border: 'border-teal-300 dark:border-teal-700',
    header: 'bg-teal-100 dark:bg-teal-900',
    text: 'text-teal-700 dark:text-teal-300',
    badge: 'bg-teal-100 dark:bg-teal-800 text-teal-700 dark:text-teal-300',
  },
  physical: {
    bg: 'bg-emerald-50 dark:bg-emerald-950',
    border: 'border-emerald-300 dark:border-emerald-700',
    header: 'bg-emerald-100 dark:bg-emerald-900',
    text: 'text-emerald-700 dark:text-emerald-300',
    badge:
      'bg-emerald-100 dark:bg-emerald-800 text-emerald-700 dark:text-emerald-300',
  },
}

const domainLabels: Record<string, string> = {
  requirements: 'REQ',
  engineering: 'EBOM',
  manufacturing: 'MBOM',
  validation: 'TEST',
  physical: 'PHYSICAL',
}

const domainIcons: Record<string, LucideIcon> = {
  requirements: ListChecks,
  engineering: Wrench,
  manufacturing: Factory,
  validation: ListChecks,
  physical: Package,
}

// Map item types to their detail routes
const itemTypeRoutes: Record<string, string> = {
  Part: '/parts/$id',
  Document: '/documents/$id',
  Requirement: '/requirements/$id',
  ChangeOrder: '/change-orders/$id',
  Task: '/tasks/$id',
  WorkOrder: '/work-orders/$id',
  PhysicalPart: '/physical-parts/$id',
}

function ThreadNodeComponent({
  id,
  data: rawData,
  sourcePosition = Position.Bottom,
  targetPosition = Position.Top,
}: ThreadNodeProps) {
  const data = rawData as unknown as ThreadNodeData &
    ThreadNodeExpandData & { onClick?: () => void }
  const colors = domainColors[data.domain] ?? engineeringColors
  const Icon = itemTypeIcons[data.itemType] || Box
  const stateStyle = useLifecycleState(data.itemType, data.state)
  const DomainIcon = domainIcons[data.domain] || Wrench
  const route = itemTypeRoutes[data.itemType]
  const { expandState, onToggleExpand } = data
  const isHorizontal = data.isHorizontal ?? false

  return (
    <div className="relative">
      {/* Primary handles sit on the lane-flow sides; the alt pair sits on
          the flipped sides for edges that travel against the lane stacking
          order (see swimLaneLayout). */}
      <Handle
        id={THREAD_HANDLE_TARGET}
        type="target"
        position={targetPosition}
        className="!bg-slate-400 !w-2 !h-2"
      />
      <Handle
        id={THREAD_HANDLE_TARGET_ALT}
        type="target"
        position={flipPosition(targetPosition)}
        className="!bg-slate-400 !w-2 !h-2"
      />
      {expandState && onToggleExpand && (
        <ThreadExpandButton
          direction="up"
          state={expandState.up}
          isHorizontal={isHorizontal}
          onClick={() => onToggleExpand(id, 'up')}
        />
      )}
      <div
        className={`
          w-[260px] rounded-lg border-2 shadow-sm overflow-hidden
          ${colors.bg} ${colors.border}
          ${data.isFocalItem ? 'ring-2 ring-cyan-500 ring-offset-2 dark:ring-offset-slate-900' : ''}
        `}
      >
        {/* Header with domain indicator */}
        <div
          className={`px-3 py-1.5 ${colors.header} flex items-center justify-between`}
        >
          <div className="flex items-center gap-1.5">
            <DomainIcon className={`h-3.5 w-3.5 ${colors.text}`} />
            <span className={`text-xs font-medium ${colors.text}`}>
              {domainLabels[data.domain] || data.domain}
            </span>
          </div>
          <span className={`text-xs ${colors.text}`}>{data.designCode}</span>
        </div>

        {/* Main content */}
        <div className="px-3 py-2 space-y-1.5">
          {/* Item number and revision */}
          <div className="flex items-center justify-between">
            {route ? (
              <Link
                to={route}
                params={{ id: data.id }}
                className="text-sm font-semibold text-cyan-600 dark:text-cyan-400 hover:underline"
              >
                {data.itemNumber}
              </Link>
            ) : (
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                {data.itemNumber}
              </span>
            )}
            {/* Physical items are not versioned — a revision is meaningless */}
            {data.domain !== 'physical' && (
              <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Rev {data.revision}
              </span>
            )}
          </div>

          {/* Item name */}
          {data.name && (
            <p className="text-xs text-slate-600 dark:text-slate-300 truncate">
              {data.name}
            </p>
          )}

          {/* Item type and state badges */}
          <div className="flex items-center gap-2 pt-1">
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs ${colors.badge}`}
            >
              <Icon className="h-3 w-3" />
              {data.itemType}
            </span>
            <span
              className={`px-1.5 py-0.5 rounded text-xs ${stateStyle.className}`}
            >
              {stateStyle.label}
            </span>
          </div>
        </div>
      </div>
      <Handle
        id={THREAD_HANDLE_SOURCE}
        type="source"
        position={sourcePosition}
        className="!bg-slate-400 !w-2 !h-2"
      />
      <Handle
        id={THREAD_HANDLE_SOURCE_ALT}
        type="source"
        position={flipPosition(sourcePosition)}
        className="!bg-slate-400 !w-2 !h-2"
      />
      {expandState && onToggleExpand && (
        <ThreadExpandButton
          direction="down"
          state={expandState.down}
          isHorizontal={isHorizontal}
          onClick={() => onToggleExpand(id, 'down')}
        />
      )}
    </div>
  )
}

export const ThreadNodeComponent_ = memo(ThreadNodeComponent)
export { ThreadNodeComponent_ as ThreadNode }
