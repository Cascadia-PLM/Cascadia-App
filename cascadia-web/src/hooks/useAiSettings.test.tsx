// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { useAiSettings } from './useAiSettings'
import type { ReactNode } from 'react'
import type { AiSettingsForm } from './useAiSettings'

const { apiFetch, invalidate } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  invalidate: vi.fn(),
}))
vi.mock('@/api/client', () => ({ apiFetch }))
vi.mock('@/query', () => ({ useInvalidateResources: () => invalidate }))

const form: AiSettingsForm = {
  enabled: true,
  provider: 'openai',
  apiKey: 'test-key',
  model: 'test-model',
}

it('reports save invalidation and connection errors', async () => {
  apiFetch.mockReset()
  invalidate.mockReset().mockResolvedValue(undefined)
  apiFetch.mockImplementation((url: string) =>
    url.endsWith('/test')
      ? Promise.reject(new Error('Bad credentials'))
      : Promise.resolve({ data: { settings: { id: 'saved-id' } } }),
  )
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const view = renderHook(useAiSettings, { wrapper })

  await act(async () => {
    expect(await view.result.current.save(form)).toBe('saved-id')
  })
  expect(invalidate).toHaveBeenCalledWith('admin')
  await waitFor(() => expect(view.result.current.saveStatus).toBe('success'))

  await act(async () => {
    expect(await view.result.current.testConnection(form)).toBe(false)
  })
  await waitFor(() => expect(view.result.current.testStatus).toBe('error'))
  expect(view.result.current.testMessage).toBe('Bad credentials')
})
