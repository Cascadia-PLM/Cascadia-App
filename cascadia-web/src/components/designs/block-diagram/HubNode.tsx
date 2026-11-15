// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * An interface drawn as a node of its own: a small pill the lines to its
 * ends meet at. An interface is drawn this way when it has more than two
 * ends (a bus), when it has only one (so the other can still be attached),
 * or when the user asked to see it as a bus in order to attach another.
 *
 * It has a connection point on each side; dragging from a port to any of
 * them attaches the interface to that port.
 */
import { memo } from 'react'
import { Handle, Position } from '@xyflow/react'
import { interfaceColor, interfaceLabel } from './interface-kinds'
import type { Node, NodeProps } from '@xyflow/react'
import type { ArchitectureInterface } from '@cascadia/commons/services/types/architecture'
import type { BlockSide } from './layout'
import { cn } from '@/utils'

export interface HubNodeData extends Record<string, unknown> {
  item: ArchitectureInterface
  editable: boolean
}

export type HubNodeType = Node<HubNodeData, 'hub'>

/** Node id of an interface's hub — distinct from every element's `itemId`. */
export const hubNodeId = (interfaceItemId: string) => `if:${interfaceItemId}`
export const interfaceIdOfHub = (nodeId: string) =>
  nodeId.startsWith('if:') ? nodeId.slice(3) : null

const SIDES: Array<{ side: BlockSide; position: Position }> = [
  { side: 'top', position: Position.Top },
  { side: 'right', position: Position.Right },
  { side: 'bottom', position: Position.Bottom },
  { side: 'left', position: Position.Left },
]

export const HubNode = memo(function HubNode({
  data,
  selected,
}: NodeProps<HubNodeType>) {
  const { item, editable } = data
  const color = interfaceColor(item.kind)
  return (
    <div
      className={cn(
        'flex h-full w-full items-center justify-center rounded-full border-2 bg-white px-3 text-[11px] font-medium text-slate-800 shadow-sm dark:bg-slate-900 dark:text-slate-100',
        selected && 'ring-2 ring-blue-500/40',
      )}
      style={{ borderColor: color }}
      title={`${item.itemNumber}${item.name ? ` ${item.name}` : ''}`}
      data-testid="architecture-interface-hub"
    >
      <span className="truncate">{interfaceLabel(item)}</span>
      {SIDES.map(({ side, position }) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={position}
          isConnectable={editable}
          className="!h-2 !w-2 !border-0"
          style={{ backgroundColor: color }}
        />
      ))}
    </div>
  )
})
