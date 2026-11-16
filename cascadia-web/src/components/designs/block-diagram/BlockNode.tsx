// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * One system element in the block diagram: a box carrying its number, name
 * and kind, with its ports down its left and right edges. An element with
 * children is drawn as a container — the same header on a larger, lightly
 * tinted box its children sit inside, its port names outside the box so
 * they do not sit on top of its contents.
 *
 * Every port is a connection point a line can be dragged from or to. Under
 * the ports on each side sits one more point, drawn hollow: dragging from or
 * to it means "a new port here", which the diagram asks the name of.
 *
 * All points are "source" handles and the canvas runs in loose connection
 * mode, so a line can be dragged in either direction between any two.
 */
import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { portRowY } from './layout'
import type { Node, NodeProps } from '@xyflow/react'
import type { ArchitectureNode } from '@cascadia/commons/services/types/architecture'
import type { PlacedPort, PortSide } from './layout'
import { ItemLink } from '@/components/items/ItemLink'
import { elementKindLabel } from '@/components/system-elements/SystemElementTable'
import { cn } from '@/utils'

export interface BlockNodeData extends Record<string, unknown> {
  element: ArchitectureNode
  isContainer: boolean
  ports: Array<PlacedPort>
  /** Lines can be drawn and ports edited; false at a tag or a commit. */
  editable: boolean
  onPortClick: (elementItemId: string, portId: string) => void
}

export type BlockNodeType = Node<BlockNodeData, 'block'>

/** Handle id of a port, and of the "new port" point on a side. */
export const portHandleId = (portId: string) => `port:${portId}`
export const newPortHandleId = (side: PortSide) => `new:${side}`

const SIDES: Array<PortSide> = ['left', 'right']
const POSITION: Record<PortSide, Position> = {
  left: Position.Left,
  right: Position.Right,
}
const DIRECTION_MARK = { in: '▸', out: '◂', inout: '◆' } as const

export const BlockNode = memo(function BlockNode({
  data,
  selected,
}: NodeProps<BlockNodeType>) {
  const { element, isContainer, ports, editable, onPortClick } = data
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
      </div>

      {ports.map(({ port, side, row }) => (
        <div key={port.id}>
          <Handle
            id={portHandleId(port.id)}
            type="source"
            position={POSITION[side]}
            isConnectable={editable}
            style={{ top: portRowY(row) }}
            className="!h-2.5 !w-2.5 !rounded-sm !border-2 !border-white !bg-slate-700 dark:!border-slate-900 dark:!bg-slate-200"
          />
          <button
            type="button"
            disabled={!editable}
            onClick={(event) => {
              event.stopPropagation()
              onPortClick(element.itemId, port.id)
            }}
            title={
              port.description
                ? `${port.name} — ${port.description}`
                : port.name
            }
            data-testid="architecture-port"
            style={{ top: portRowY(row) }}
            className={cn(
              'nodrag absolute flex max-w-[104px] -translate-y-1/2 items-center gap-1 rounded px-1 text-[11px] leading-4 text-slate-700 dark:text-slate-300',
              editable &&
                'cursor-pointer hover:bg-slate-200 dark:hover:bg-slate-700',
              side === 'right' && 'flex-row-reverse',
              // A container's port names sit outside it, clear of its contents.
              isContainer
                ? side === 'left'
                  ? 'right-full mr-2'
                  : 'left-full ml-2'
                : side === 'left'
                  ? 'left-2'
                  : 'right-2',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'text-[8px] text-slate-400',
                side === 'right' && port.direction !== 'inout' && 'rotate-180',
              )}
            >
              {DIRECTION_MARK[port.direction]}
            </span>
            <span className="truncate">{port.name}</span>
          </button>
        </div>
      ))}

      {SIDES.map((side) => {
        const rows = ports.filter((placed) => placed.side === side).length
        return (
          <Handle
            key={side}
            id={newPortHandleId(side)}
            type="source"
            position={POSITION[side]}
            isConnectable={editable}
            style={{ top: portRowY(rows) }}
            title="Drag from here to connect through a new port"
            className={cn(
              '!h-2.5 !w-2.5 !border-2 !border-dashed !border-teal-600 !bg-white dark:!bg-slate-900',
              !editable && '!opacity-0',
            )}
          />
        )
      })}
    </div>
  )
})
