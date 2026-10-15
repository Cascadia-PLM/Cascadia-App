// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { useLifecyclePhases } from './useLifecyclePhases'
import type { ReactNode } from 'react'
import type { ItemTypeLifecycle } from '@/query/options/lifecycles'
import { lifecycleByItemTypeQuery } from '@/query'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('@/api/client', () => ({ apiFetch }))

const definition = (phase: string): ItemTypeLifecycle => ({
  lifecycleId: 'part-lifecycle',
  name: 'Part',
  lifecycleType: 'Driven',
  phases: [{ id: 'phase', name: phase, order: 0 }],
  states: [{ id: 'released', name: 'Released', phaseId: 'phase' }],
  transitions: [],
  revisionScheme: null,
  changeActionMappings: {},
})

it('shares loader data and refreshes badges after lifecycle invalidation', async () => {
  apiFetch.mockReset()
  apiFetch.mockResolvedValue({ data: definition('Production') })
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const query = lifecycleByItemTypeQuery('Part')
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  client.setQueryData(query.queryKey, definition('Prototype'))
  const view = renderHook(() => useLifecyclePhases('Part'), { wrapper })
  expect(view.result.current.data?.phases[0]?.name).toBe('Prototype')
  expect(apiFetch).not.toHaveBeenCalled()

  await act(async () => {
    await client.invalidateQueries({ queryKey: query.queryKey })
  })
  await waitFor(() =>
    expect(view.result.current.data?.phases[0]?.name).toBe('Production'),
  )
  expect(apiFetch).toHaveBeenCalledTimes(1)
})
