// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * Where the blocks of the architecture diagram sit, and where on each block
 * its ports are drawn.
 *
 * The diagram is the DECOMPOSES forest drawn as nested boxes: an element
 * with children is a container, and its children sit inside it. A block's
 * position is relative to the block it is inside, so dragging a container
 * carries its contents and a saved position survives its parent moving.
 *
 * Sizes are never stored. A leaf is as tall as its ports need and a
 * container is exactly as large as its contents need, recomputed on every
 * pass — so a container grows when a block is added to it or dragged
 * towards its edge, and nothing has to be resized by hand.
 *
 * A block with a saved position is put there (kept inside its container's
 * content area); one without is packed in rows beneath the saved ones, which
 * is also the whole layout of a diagram nobody has arranged yet.
 *
 * Ports are not stored anywhere either: a port is drawn on the left or the
 * right edge of its block, whichever faces what it is connected to, so the
 * lines stay short however the blocks are arranged.
 */
import type {
  ArchitectureInterface,
  ArchitectureLayout,
  ArchitectureNode,
} from '@cascadia/commons/services/types/architecture'
import type { SystemPort } from '@cascadia/commons/items/types/system-element'

export const BLOCK_WIDTH = 240
const MIN_LEAF_HEIGHT = 72
/** The strip at the top of a block that carries its number and name. */
export const BLOCK_HEADER = 52
export const CONTAINER_PADDING = 24
/** Vertical pitch of the ports down a block's edge. */
export const PORT_ROW = 22
/** Room between sibling blocks — enough for a line and its label. */
const GAP = 96

/** An interface drawn as a node of its own: a bus, or a line with one end. */
export const HUB_WIDTH = 132
export const HUB_HEIGHT = 30

export type PortSide = 'left' | 'right'

/** How many port rows each side of each block needs, by element `itemId`. */
export type PortRows = Map<string, number>

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

export interface PlacedBlock extends Box {
  element: ArchitectureNode
  /** `itemId` of the block this one sits inside; null for a root. */
  parentItemId: string | null
  isContainer: boolean
}

/** A block measured but not yet positioned, with its contents laid out. */
interface Sized {
  element: ArchitectureNode
  width: number
  height: number
  /** This block's children, positioned relative to it. */
  inner: Array<Nested>
}

/** A positioned block still holding its own contents, before flattening. */
interface Nested extends PlacedBlock {
  inner: Array<Nested>
}

/**
 * The height the ports of a block need: its rows, plus one for the "new
 * port" point that sits beneath them on each side.
 */
function portsHeight(rows: number): number {
  return BLOCK_HEADER + (rows + 1) * PORT_ROW + 6
}

/** The y of port row `index` (0-based), from the top of its block. */
export function portRowY(index: number): number {
  return BLOCK_HEADER + index * PORT_ROW + PORT_ROW / 2
}

/**
 * Position `siblings` inside one container (or the canvas). `minX`/`minY` is
 * the top-left of the area they may occupy.
 */
function arrange(
  siblings: Array<Sized>,
  parentItemId: string | null,
  saved: ArchitectureLayout,
  minX: number,
  minY: number,
): Array<Nested> {
  const placed: Array<Nested> = []
  const loose: Array<Sized> = []
  let savedBottom = minY - GAP

  const at = (block: Sized, x: number, y: number): Nested => ({
    element: block.element,
    parentItemId,
    x,
    y,
    width: block.width,
    height: block.height,
    isContainer: block.inner.length > 0,
    inner: block.inner,
  })

  for (const block of siblings) {
    const position = saved[block.element.masterId]
    if (!position) {
      loose.push(block)
      continue
    }
    // Inside a container a block cannot sit over the header or outside the
    // top-left padding; the canvas has no such edge.
    const x = parentItemId ? Math.max(position.x, minX) : position.x
    const y = parentItemId ? Math.max(position.y, minY) : position.y
    placed.push(at(block, x, y))
    savedBottom = Math.max(savedBottom, y + block.height)
  }

  // The rest, in rows of roughly square proportion beneath what is placed.
  const perRow = Math.max(1, Math.ceil(Math.sqrt(loose.length)))
  let x = minX
  let y = savedBottom + GAP
  let rowHeight = 0
  loose.forEach((block, index) => {
    if (index > 0 && index % perRow === 0) {
      x = minX
      y += rowHeight + GAP
      rowHeight = 0
    }
    placed.push(at(block, x, y))
    x += block.width + GAP
    rowHeight = Math.max(rowHeight, block.height)
  })
  return placed
}

function measure(
  element: ArchitectureNode,
  saved: ArchitectureLayout,
  portRows: PortRows,
): Sized {
  const forPorts = portsHeight(portRows.get(element.itemId) ?? 0)
  if (element.children.length === 0) {
    return {
      element,
      width: BLOCK_WIDTH,
      height: Math.max(MIN_LEAF_HEIGHT, forPorts),
      inner: [],
    }
  }
  const inner = arrange(
    element.children.map((child) => measure(child, saved, portRows)),
    element.itemId,
    saved,
    // A container's ports are labelled outside it, but the lines its
    // children draw to its own edge still want room.
    CONTAINER_PADDING * 2,
    BLOCK_HEADER + CONTAINER_PADDING / 2,
  )
  const right = Math.max(...inner.map((block) => block.x + block.width))
  const bottom = Math.max(...inner.map((block) => block.y + block.height))
  return {
    element,
    width: Math.max(BLOCK_WIDTH, right + CONTAINER_PADDING * 2),
    height: Math.max(bottom + CONTAINER_PADDING, forPorts),
    inner,
  }
}

/**
 * Every block of the forest with its position and size, a container always
 * before the blocks inside it — the order React Flow needs to nest them.
 */
export function layoutBlocks(
  roots: Array<ArchitectureNode>,
  saved: ArchitectureLayout,
  portRows: PortRows,
): Array<PlacedBlock> {
  const out: Array<PlacedBlock> = []
  const emit = ({ inner, ...block }: Nested) => {
    out.push(block)
    inner.forEach(emit)
  }
  arrange(
    roots.map((root) => measure(root, saved, portRows)),
    null,
    saved,
    0,
    0,
  ).forEach(emit)
  return out
}

/** Every block's box in canvas coordinates, by `itemId`. */
export function absoluteBoxes(blocks: Array<PlacedBlock>): Map<string, Box> {
  const out = new Map<string, Box>()
  // Containers precede their contents, so a parent is always resolved first.
  for (const block of blocks) {
    const parent = block.parentItemId ? out.get(block.parentItemId) : undefined
    out.set(block.element.itemId, {
      x: (parent?.x ?? 0) + block.x,
      y: (parent?.y ?? 0) + block.y,
      width: block.width,
      height: block.height,
    })
  }
  return out
}

function centerX(box: Box): number {
  return box.x + box.width / 2
}

export interface PlacedPort {
  port: SystemPort
  side: PortSide
  /** 0-based row down that side of the block. */
  row: number
}

/**
 * Which edge of its block each port is drawn on, and in which row.
 *
 * A connected port faces the blocks at the other ends of its interfaces; an
 * unconnected one goes by its direction — inputs on the left, everything
 * else on the right. Rows are in name order, so a port keeps its place
 * while the blocks around it move.
 */
export function placePorts(
  blocks: Array<PlacedBlock>,
  interfaces: Array<ArchitectureInterface>,
): Map<string, Array<PlacedPort>> {
  const boxes = absoluteBoxes(blocks)

  // For each port, the x of everything its interfaces reach.
  const reaches = new Map<string, Array<number>>()
  for (const item of interfaces) {
    for (const end of item.ends) {
      if (!end.portId) continue
      const others = item.ends.filter((other) => other !== end)
      for (const other of others) {
        const box = boxes.get(other.elementItemId)
        if (!box) continue
        const key = `${end.elementItemId}:${end.portId}`
        reaches.set(key, [...(reaches.get(key) ?? []), centerX(box)])
      }
    }
  }

  const out = new Map<string, Array<PlacedPort>>()
  for (const block of blocks) {
    const box = boxes.get(block.element.itemId)
    if (!box) continue
    const sideOf = (port: SystemPort): PortSide => {
      const xs = reaches.get(`${block.element.itemId}:${port.id}`)
      if (!xs || xs.length === 0) {
        return port.direction === 'in' ? 'left' : 'right'
      }
      const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length
      return mean >= centerX(box) ? 'right' : 'left'
    }
    const rows: Record<PortSide, number> = { left: 0, right: 0 }
    out.set(
      block.element.itemId,
      [...block.element.ports]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((port) => {
          const side = sideOf(port)
          return { port, side, row: rows[side]++ }
        }),
    )
  }
  return out
}

/** The rows each block needs for `placed` — the taller of its two sides. */
export function portRowsOf(placed: Map<string, Array<PlacedPort>>): PortRows {
  const out: PortRows = new Map()
  for (const [itemId, ports] of placed) {
    out.set(itemId, Math.max(0, ...ports.map((port) => port.row + 1)))
  }
  return out
}

export type BlockSide = 'top' | 'right' | 'bottom' | 'left'

/**
 * Which side of a hub node a line to `other` should leave by: the one
 * facing it along whichever axis separates the two more.
 */
export function facingSide(from: Box, other: Box): BlockSide {
  const dx = centerX(other) - centerX(from)
  const dy = other.y + other.height / 2 - (from.y + from.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left'
  return dy >= 0 ? 'bottom' : 'top'
}

/**
 * Where an interface's hub node goes when nobody has placed it: the middle
 * of the blocks it joins, or just to the right of the only one.
 */
export function defaultHubPosition(ends: Array<Box>): { x: number; y: number } {
  if (ends.length === 0) return { x: 0, y: -HUB_HEIGHT * 2 }
  const only = ends.length === 1 ? ends[0] : undefined
  if (only) {
    return {
      x: only.x + only.width + GAP / 2,
      y: only.y + BLOCK_HEADER,
    }
  }
  const mean = (values: Array<number>) =>
    values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    x: Math.round(mean(ends.map(centerX)) - HUB_WIDTH / 2),
    y: Math.round(
      mean(ends.map((box) => box.y + box.height / 2)) - HUB_HEIGHT / 2,
    ),
  }
}
