// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useMemo, useRef, useState } from 'react'

/** The modifier keys a click carries, as a React mouse event reports them. */
export interface SelectionModifiers {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

export interface ListSelection<T> {
  /** The chosen rows, in the order they were picked. */
  selected: Array<T>
  isSelected: (id: string) => boolean
  /**
   * A row was clicked. Shift extends the range from the last row clicked;
   * anything else toggles the one row.
   */
  handleRowClick: (item: T, event: SelectionModifiers) => void
  /** Add every row currently in `items` to the selection. */
  selectAll: () => void
  /** Drop one row, by id, wherever it came from. */
  remove: (id: string) => void
  clear: () => void
  /** Every row currently in `items` is chosen. False when there are none. */
  allVisibleSelected: boolean
}

/**
 * Multi-select over a flat list, with the modifier keys every file manager has
 * trained people to expect.
 *
 * Plain click toggles, so several rows can be picked without holding anything
 * down; ctrl/cmd+click does the same thing explicitly; shift+click adds
 * everything between the last row clicked and this one. That is the vocabulary
 * `useTreeSelection` already uses for the BOM tree, so the two read alike.
 *
 * Selections are held as whole rows and outlive `items`. Picking rows across
 * several searches is the normal way to use a picker like this, and a selection
 * pruned to whatever the search box currently matches would silently drop
 * everything found under an earlier term.
 */
export function useListSelection<T extends { id: string }>(
  items: Array<T>,
): ListSelection<T> {
  // Insertion-ordered, so `selected` reads back in the order rows were picked.
  // Rows chosen under different search terms share no other order.
  const [selected, setSelected] = useState<Map<string, T>>(new Map())
  // Where the next shift+click measures its range from.
  const anchorIdRef = useRef<string | null>(null)

  const toggle = useCallback((item: T) => {
    setSelected((prev) => {
      const next = new Map(prev)
      if (next.has(item.id)) {
        next.delete(item.id)
      } else {
        next.set(item.id, item)
      }
      return next
    })
    anchorIdRef.current = item.id
  }, [])

  const handleRowClick = useCallback(
    (item: T, event: SelectionModifiers) => {
      const anchorId = anchorIdRef.current
      if (event.shiftKey && anchorId !== null) {
        const anchorIdx = items.findIndex((row) => row.id === anchorId)
        const currentIdx = items.findIndex((row) => row.id === item.id)

        if (anchorIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(anchorIdx, currentIdx)
          const end = Math.max(anchorIdx, currentIdx)
          setSelected((prev) => {
            const next = new Map(prev)
            for (const row of items.slice(start, end + 1)) {
              next.set(row.id, row)
            }
            return next
          })
          // The anchor stays put, so dragging the shift+click up and down
          // re-measures from the same row rather than walking away from it.
          return
        }
        // The anchor is no longer on screen — a new search term, most likely —
        // so there is no range to extend. Fall through and toggle this row,
        // which also re-anchors here for the next shift+click.
      }

      toggle(item)
    },
    [items, toggle],
  )

  const selectAll = useCallback(() => {
    setSelected((prev) => {
      const next = new Map(prev)
      for (const item of items) {
        next.set(item.id, item)
      }
      return next
    })
  }, [items])

  const remove = useCallback((id: string) => {
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Map(prev)
      next.delete(id)
      return next
    })
  }, [])

  const clear = useCallback(() => {
    setSelected(new Map())
    anchorIdRef.current = null
  }, [])

  const isSelected = useCallback((id: string) => selected.has(id), [selected])

  const selectedList = useMemo(() => [...selected.values()], [selected])

  const allVisibleSelected =
    items.length > 0 && items.every((item) => selected.has(item.id))

  return {
    selected: selectedList,
    isSelected,
    handleRowClick,
    selectAll,
    remove,
    clear,
    allVisibleSelected,
  }
}
