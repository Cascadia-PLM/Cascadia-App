// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `VersionContextSelector` — the auto-select correction.
 *
 * When the URL names a context the item does not exist in, this component
 * rewrites it, and every caller wires `onChange` to a `navigate`. So the
 * invariant is not about markup: **one stale context must produce one
 * correction, not one per render.**
 *
 * It used to produce one per render. `branches` and `tags` were a fresh
 * `.filter()` result on every render and sat in the effect's dependency
 * array, so the effect ran after every commit — and on an item detail page
 * the part page is simultaneously rewriting the *id* half of the same URL
 * from its own resolver. Two effects correcting different halves of one URL,
 * each re-firing on every render the other caused, is a navigate loop; React
 * ends it at 50 nested updates with "Maximum update depth exceeded", thrown
 * from whichever library ref callback runs next rather than from here.
 *
 * Run: npx vitest run packages/core/src/components/versioning/VersionContextSelector.test.tsx
 */

import { render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { VersionContextSelector } from './VersionContextSelector'
import type { ReactNode } from 'react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type * as ApiClient from '@/lib/api/client'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/lib/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClient>()),
  apiFetch,
}))

const ECO_BRANCH = {
  id: 'branch-eco',
  name: 'ECO-0001',
  branchType: 'eco',
  isArchived: false,
  isLocked: false,
  exists: true,
}

function wrapper(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('VersionContextSelector auto-select', () => {
  it('corrects an unavailable context once, not once per render', async () => {
    apiFetch.mockResolvedValue({
      data: { branches: [ECO_BRANCH], tags: [] },
    })
    const onChange = vi.fn()

    // Stable across rerenders, exactly as the callers hold it: `context` is a
    // useMemo on the URL search, and `setContext` a useCallback.
    const value: VersionContext = {
      type: 'branch',
      branchId: 'branch-that-was-deleted',
    }
    const selector = (
      <VersionContextSelector
        designId="design-1"
        itemId="item-1"
        value={value}
        onChange={onChange}
        variant="breadcrumb"
      />
    )

    const { rerender } = render(wrapper(selector))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        type: 'branch',
        branchId: ECO_BRANCH.id,
        branchName: ECO_BRANCH.name,
      })
    })

    // The caller's navigate has not landed yet, so `value` is still the stale
    // one — the window in which the loop used to run. Re-render the way a
    // parent higher up the tree would while that is in flight.
    for (let i = 0; i < 5; i++) {
      rerender(wrapper(selector))
    }

    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
