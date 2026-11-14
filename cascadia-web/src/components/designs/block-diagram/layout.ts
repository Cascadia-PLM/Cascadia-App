// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * Where the blocks of the architecture diagram sit.
 *
 * The diagram is the DECOMPOSES forest drawn as nested boxes: an element
 * with children is a container, and its children sit inside it. A block's
 * position is relative to the block it is inside, so dragging a container
 * carries its contents and a saved position survives its parent moving.
 *
 * Sizes are never stored. A leaf has a fixed size and a container is exactly
 * as large as its contents need, recomputed on every pass — so a container
 * grows when a block is added to it or dragged towards its edge, and nothing
 * has to be resized by hand.
 *
 * A block with a saved position is put there (kept inside its container's
 * content area); one without is packed in rows beneath the saved ones, which
 * is also the whole layout of a diagram nobody has arranged yet.
 */
import type {
  ArchitectureLayout,
  ArchitectureNode,
} from '@cascadia/commons/services/types/architecture'

export const LEAF_WIDTH = 220
export const LEAF_HEIGHT = 72
/** The strip at the top of a container that carries its own number and name. */
export const CONTAINER_HEADER = 52
export const CONTAINER_PADDING = 20
/** Room between sibling blocks — enough for a connection and its label. */
const GAP = 72

export interface PlacedBlock {
  element: ArchitectureNode
  /** `itemId` of the block this one sits inside; null for a root. */
  parentItemId: string | null
  /** Relative to the parent block's top-left corner (the canvas for a root). */
  x: number
  y: number
  width: number
  height: number
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

function measure(element: ArchitectureNode, saved: ArchitectureLayout): Sized {
  if (element.children.length === 0) {
    return { element, width: LEAF_WIDTH, height: LEAF_HEIGHT, inner: [] }
  }
  const inner = arrange(
    element.children.map((child) => measure(child, saved)),
    element.itemId,
    saved,
    CONTAINER_PADDING,
    CONTAINER_HEADER,
  )
  const right = Math.max(...inner.map((block) => block.x + block.width))
  const bottom = Math.max(...inner.map((block) => block.y + block.height))
  return {
    element,
    width: Math.max(LEAF_WIDTH, right + CONTAINER_PADDING),
    height: bottom + CONTAINER_PADDING,
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
): Array<PlacedBlock> {
  const out: Array<PlacedBlock> = []
  const emit = ({ inner, ...block }: Nested) => {
    out.push(block)
    inner.forEach(emit)
  }
  arrange(
    roots.map((root) => measure(root, saved)),
    null,
    saved,
    0,
    0,
  ).forEach(emit)
  return out
}

/** Top-left of every block in canvas coordinates, by `itemId`. */
export function absolutePositions(
  blocks: Array<PlacedBlock>,
): Map<string, { x: number; y: number; width: number; height: number }> {
  const out = new Map<
    string,
    { x: number; y: number; width: number; height: number }
  >()
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

export type BlockSide = 'top' | 'right' | 'bottom' | 'left'

/**
 * Which sides of two blocks a connection should leave and enter by: the
 * pair facing each other along whichever axis separates the blocks more.
 */
export function facingSides(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): { source: BlockSide; target: BlockSide } {
  const dx = target.x + target.width / 2 - (source.x + source.width / 2)
  const dy = target.y + target.height / 2 - (source.y + source.height / 2)
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { source: 'right', target: 'left' }
      : { source: 'left', target: 'right' }
  }
  return dy >= 0
    ? { source: 'bottom', target: 'top' }
    : { source: 'top', target: 'bottom' }
}
