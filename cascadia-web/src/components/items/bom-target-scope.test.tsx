// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `useRelationshipTargets` scope tests.
 *
 * These exist because the scope is the only guard there is. `POST
 * /api/v1/items/:id/relationships` hands its body straight to
 * `ItemService.addRelationship` with no check that a BOM target belongs to the
 * source item's design — so "BOM lines stay within one design", which the
 * dialog states as fact to the user, holds only for as long as this hook never
 * offers anything outside it. A picker that widened its search would produce
 * cross-design BOM structure that nothing downstream would reject.
 *
 * The invariant is therefore about the requests, not the rendering: whatever
 * mode the picker is in, under BOM every item request it makes must name a
 * scope.
 *
 * Run: npm run test -- src/components/items/bom-target-scope.test.tsx
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import React from 'react'
import { useRelationshipTargets } from './bom-target-scope'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', () => ({ apiFetch }))

const SOURCE_ITEM_ID = 'item-1'
const SOURCE_MASTER_ID = 'master-1'
const DESIGN_ID = 'design-1'

/** Every URL the hook asked for, in order. */
let requested: Array<string>

function itemRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'target-1',
    masterId: 'master-2',
    itemNumber: 'PRT-0001',
    revision: 'A',
    itemType: 'Part',
    name: 'A part',
    state: 'Draft',
    ...over,
  }
}

beforeEach(() => {
  requested = []
  apiFetch.mockReset()
  apiFetch.mockImplementation((url: string) => {
    requested.push(url)
    if (url.startsWith(`/api/v1/items/${SOURCE_ITEM_ID}`)) {
      return Promise.resolve({
        data: { item: { masterId: SOURCE_MASTER_ID, designId: DESIGN_ID } },
      })
    }
    if (url.startsWith('/api/v1/designs/')) {
      return Promise.resolve({ data: { design: { code: 'D-1', name: 'D' } } })
    }
    return Promise.resolve({ data: { items: [itemRow()] } })
  })
})

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  return React.createElement(QueryClientProvider, { client }, children)
}

/** Item-search URLs only — the source item and design lookups are not targets. */
function searchUrls() {
  return requested.filter((u) => u.startsWith('/api/v1/items/search'))
}

describe('useRelationshipTargets scope', () => {
  it('never asks unscoped while browsing under BOM', async () => {
    renderHook(
      () =>
        useRelationshipTargets({
          itemId: SOURCE_ITEM_ID,
          relationshipType: 'BOM',
          itemType: 'Part',
        }),
      { wrapper },
    )

    await waitFor(() => expect(searchUrls().length).toBeGreaterThanOrEqual(2))
    for (const url of searchUrls()) {
      expect(url).toContain('designScope=')
    }
  })

  it('never asks unscoped while searching under BOM', async () => {
    renderHook(
      () =>
        useRelationshipTargets({
          itemId: SOURCE_ITEM_ID,
          relationshipType: 'BOM',
          itemType: 'Part',
          search: 'BRACKET',
        }),
      { wrapper },
    )

    await waitFor(() =>
      expect(searchUrls().some((u) => u.includes('q=BRACKET'))).toBe(true),
    )
    for (const url of searchUrls()) {
      expect(url).toContain('designScope=')
    }
  })

  it('covers both the design and the library when searching under BOM', async () => {
    renderHook(
      () =>
        useRelationshipTargets({
          itemId: SOURCE_ITEM_ID,
          relationshipType: 'BOM',
          itemType: 'Part',
          search: 'BRACKET',
        }),
      { wrapper },
    )

    await waitFor(() => {
      const searches = searchUrls().filter((u) => u.includes('q=BRACKET'))
      expect(searches.some((u) => u.includes('designScope=current'))).toBe(true)
      expect(searches.some((u) => u.includes('designScope=library'))).toBe(true)
    })
  })

  it('sends the term to the server rather than filtering what it fetched', async () => {
    renderHook(
      () =>
        useRelationshipTargets({
          itemId: SOURCE_ITEM_ID,
          relationshipType: 'Reference',
          itemType: 'Document',
          search: 'NEEDLE',
        }),
      { wrapper },
    )

    // The whole point of the rework: the term reaches the API, so a match
    // outside the browse window is still findable.
    await waitFor(() =>
      expect(
        searchUrls().some(
          (u) => u.includes('q=NEEDLE') && u.includes('types=Document'),
        ),
      ).toBe(true),
    )
  })

  it('does not send a term too short for the server to answer', async () => {
    renderHook(
      () =>
        useRelationshipTargets({
          itemId: SOURCE_ITEM_ID,
          relationshipType: 'Reference',
          itemType: 'Part',
          search: 'A',
        }),
      { wrapper },
    )

    await waitFor(() => expect(searchUrls().length).toBeGreaterThanOrEqual(1))
    expect(searchUrls().some((u) => u.includes('q='))).toBe(false)
  })

  it('leaves non-BOM pickers unscoped, as cross-design reference intends', async () => {
    renderHook(
      () =>
        useRelationshipTargets({
          itemId: SOURCE_ITEM_ID,
          relationshipType: 'Reference',
          itemType: 'Part',
          search: 'BRACKET',
        }),
      { wrapper },
    )

    await waitFor(() =>
      expect(searchUrls().some((u) => u.includes('q=BRACKET'))).toBe(true),
    )
    for (const url of searchUrls()) {
      expect(url).not.toContain('designScope=')
    }
  })

  it('never offers the source item as its own BOM child', async () => {
    apiFetch.mockImplementation((url: string) => {
      requested.push(url)
      if (url.startsWith(`/api/v1/items/${SOURCE_ITEM_ID}`)) {
        return Promise.resolve({
          data: { item: { masterId: SOURCE_MASTER_ID, designId: DESIGN_ID } },
        })
      }
      if (url.startsWith('/api/v1/designs/')) {
        return Promise.resolve({ data: { design: { code: 'D-1', name: 'D' } } })
      }
      // The source item comes back on a different branch, so a different row
      // id but the same masterId.
      return Promise.resolve({
        data: {
          items: [
            itemRow({ id: 'other-branch-copy', masterId: SOURCE_MASTER_ID }),
            itemRow({ id: 'target-2', masterId: 'master-3' }),
          ],
        },
      })
    })

    const { result } = renderHook(
      () =>
        useRelationshipTargets({
          itemId: SOURCE_ITEM_ID,
          relationshipType: 'BOM',
          itemType: 'Part',
        }),
      { wrapper },
    )

    await waitFor(() => expect(result.current.candidates.length).toBe(1))
    expect(result.current.candidates.map((c) => c.id)).toEqual(['target-2'])
  })
})
