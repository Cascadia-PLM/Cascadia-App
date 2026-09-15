// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { act, renderHook } from '@testing-library/react'
import { useListSelection } from './useListSelection'

interface Row {
  id: string
}

const rows = (...ids: Array<string>): Array<Row> => ids.map((id) => ({ id }))
const ids = (selected: Array<Row>): Array<string> => selected.map((r) => r.id)

const PLAIN = { shiftKey: false, ctrlKey: false, metaKey: false }
const SHIFT = { shiftKey: true, ctrlKey: false, metaKey: false }
const CTRL = { shiftKey: false, ctrlKey: true, metaKey: false }

describe('useListSelection', () => {
  it('toggles a row on plain click', () => {
    const items = rows('a', 'b', 'c')
    const { result } = renderHook(() => useListSelection(items))

    act(() => result.current.handleRowClick(items[0]!, PLAIN))
    expect(ids(result.current.selected)).toEqual(['a'])

    act(() => result.current.handleRowClick(items[0]!, PLAIN))
    expect(result.current.selected).toEqual([])
  })

  it('accumulates rows without a modifier held', () => {
    const items = rows('a', 'b', 'c')
    const { result } = renderHook(() => useListSelection(items))

    act(() => result.current.handleRowClick(items[0]!, PLAIN))
    act(() => result.current.handleRowClick(items[2]!, CTRL))

    expect(ids(result.current.selected)).toEqual(['a', 'c'])
  })

  it('selects the inclusive range on shift+click, in either direction', () => {
    const items = rows('a', 'b', 'c', 'd', 'e')
    const { result } = renderHook(() => useListSelection(items))

    act(() => result.current.handleRowClick(items[1]!, PLAIN))
    act(() => result.current.handleRowClick(items[3]!, SHIFT))
    expect(ids(result.current.selected)).toEqual(['b', 'c', 'd'])

    act(() => result.current.clear())
    act(() => result.current.handleRowClick(items[3]!, PLAIN))
    act(() => result.current.handleRowClick(items[1]!, SHIFT))
    expect(ids(result.current.selected).sort()).toEqual(['b', 'c', 'd'])
  })

  it('keeps the anchor put so a range can be re-measured', () => {
    const items = rows('a', 'b', 'c', 'd')
    const { result } = renderHook(() => useListSelection(items))

    act(() => result.current.handleRowClick(items[0]!, PLAIN))
    act(() => result.current.handleRowClick(items[2]!, SHIFT))
    // Reaching further from the same anchor extends rather than restarting
    act(() => result.current.handleRowClick(items[3]!, SHIFT))

    expect(ids(result.current.selected)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('shift+click toggles when the anchor has left the list', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: Array<Row> }) => useListSelection(items),
      { initialProps: { items: rows('a', 'b', 'c') } },
    )

    act(() => result.current.handleRowClick({ id: 'a' }, PLAIN))
    // A new search term replaces the list; the anchor is no longer in it
    const next = rows('x', 'y', 'z')
    rerender({ items: next })
    act(() => result.current.handleRowClick(next[1]!, SHIFT))

    expect(ids(result.current.selected)).toEqual(['a', 'y'])
  })

  it('keeps rows picked under an earlier search term', () => {
    const { result, rerender } = renderHook(
      ({ items }: { items: Array<Row> }) => useListSelection(items),
      { initialProps: { items: rows('a', 'b') } },
    )

    act(() => result.current.handleRowClick({ id: 'a' }, PLAIN))
    rerender({ items: rows('c', 'd') })
    act(() => result.current.handleRowClick({ id: 'c' }, PLAIN))

    expect(ids(result.current.selected)).toEqual(['a', 'c'])
    // ...and stay removable once they are off screen
    act(() => result.current.remove('a'))
    expect(ids(result.current.selected)).toEqual(['c'])
  })

  it('reports whether every visible row is selected', () => {
    const items = rows('a', 'b')
    const { result } = renderHook(() => useListSelection(items))

    expect(result.current.allVisibleSelected).toBe(false)
    act(() => result.current.selectAll())
    expect(ids(result.current.selected)).toEqual(['a', 'b'])
    expect(result.current.allVisibleSelected).toBe(true)
  })

  it('treats an empty list as not fully selected', () => {
    const { result } = renderHook(() => useListSelection<Row>([]))
    expect(result.current.allVisibleSelected).toBe(false)
  })
})
