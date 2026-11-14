// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * One system element in the block diagram: a box carrying its number, name
 * and kind. An element with children is drawn as a container — the same
 * header on a larger, lightly tinted box its children sit inside.
 *
 * Each side has one connection point. They are all "source" handles and the
 * canvas runs in loose connection mode, so a line can be dragged from any
 * side of one block to any side of another; which element is the source of
 * the stored connection is simply the one the drag started on.
 */
import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { Node, NodeProps } from '@xyflow/react'
import type { ArchitectureNode } from '@cascadia/commons/services/types/architecture'
import type { BlockSide } from './layout'
import { ItemLink } from '@/components/items/ItemLink'
import { elementKindLabel } from '@/components/system-elements/SystemElementTable'
import { cn } from '@/utils'

export interface BlockNodeData extends Record<string, unknown> {
  element: ArchitectureNode
  isContainer: boolean
  /** Connection points are shown only where a line can be drawn. */
  connectable: boolean
}

export type BlockNodeType = Node<BlockNodeData, 'block'>

const SIDES: Array<{ side: BlockSide; position: Position }> = [
  { side: 'top', position: Position.Top },
  { side: 'right', position: Position.Right },
  { side: 'bottom', position: Position.Bottom },
  { side: 'left', position: Position.Left },
]

export const BlockNode = memo(function BlockNode({
  data,
  selected,
}: NodeProps<BlockNodeType>) {
  const { element, isContainer, connectable } = data
  const realized = element.realizedBy.length
  return (
    <div
      className={cn(
        'h-full w-full rounded-lg border-2 text-left shadow-sm',
        isContainer
          ? 'border-teal-600/50 bg-teal-50/60 dark:border-teal-500/40 dark:bg-teal-950/30'
          : 'border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-900',
        selected &&
          'border-blue-500 ring-2 ring-blue-500/30 dark:border-blue-400',
      )}
      data-testid="architecture-block"
    >
      <div className="flex flex-col gap-0.5 px-3 py-2">
        <div className="flex items-center justify-between gap-2">
          <ItemLink
            itemType="SystemElement"
            itemId={element.itemId}
            className="nodrag truncate font-mono text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
          >
            {element.itemNumber}
          </ItemLink>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {elementKindLabel(element.elementKind)}
          </span>
        </div>
        <div
          className="truncate text-sm font-medium text-slate-900 dark:text-slate-100"
          title={element.name ?? undefined}
        >
          {element.name || 'Unnamed element'}
        </div>
        {!isContainer && (
          <div className="truncate text-[11px] text-slate-500 dark:text-slate-400">
            {realized === 0
              ? 'Not yet realized'
              : `Realized by ${element.realizedBy
                  .map((link) => link.itemNumber)
                  .join(', ')}`}
          </div>
        )}
      </div>
      {SIDES.map(({ side, position }) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={position}
          isConnectable={connectable}
          className={cn(
            '!h-2.5 !w-2.5 !border-2 !border-white !bg-teal-600 dark:!border-slate-900',
            !connectable && '!opacity-0',
          )}
        />
      ))}
    </div>
  )
})
