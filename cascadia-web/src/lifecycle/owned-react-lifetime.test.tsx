// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { StrictMode } from 'react'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { useOwnedElement } from './useOwnedElement'
import { useOwnedResource } from './useOwnedResource'

it('releases late acquisitions across StrictMode and identity replacement without publishing them', async () => {
  const pending: Array<{ id: string; resolve: (value: string) => void }> = []
  const release = vi.fn()
  const ready = vi.fn()
  const { result, rerender, unmount } = renderHook(
    ({ id }) =>
      useOwnedResource(
        id,
        (identity, lifetime) =>
          lifetime.acquire(
            () =>
              new Promise<string>((resolve) => {
                pending.push({ id: identity, resolve })
              }),
            release,
          ),
        { ready },
      ),
    { initialProps: { id: 'old' }, wrapper: StrictMode },
  )
  rerender({ id: 'new' })
  await act(() => {
    pending.forEach((request) => request.resolve(request.id))
  })
  expect(result.current).toEqual({ kind: 'ready', value: 'new' })
  expect(ready).toHaveBeenCalledExactlyOnceWith('new')
  expect(release).toHaveBeenCalledTimes(2)
  unmount()
  expect(release).toHaveBeenCalledTimes(3)
})

it('uses the same Object.is identity contract for effects and their projected state', async () => {
  const { result } = renderHook(() => useOwnedResource(NaN, () => 7))
  await waitFor(() =>
    expect(result.current).toEqual({ kind: 'ready', value: 7 }),
  )
})

it('updates element observers without restarting the resource and blocks cleanup callbacks', () => {
  const emitters: Array<(event: string) => void> = []
  const release = vi.fn()
  function Element({
    identity,
    attachment,
    onEvent,
  }: {
    identity: string
    attachment: string
    onEvent: (event: string) => void
  }) {
    const ref = useOwnedElement(
      identity,
      (_element, lifetime, emit) => {
        emitters.push(emit)
        lifetime.acquire(
          () => emit,
          (retained) => {
            release()
            retained('cleanup')
          },
        )
      },
      onEvent,
    )
    return <div key={attachment} ref={ref} />
  }
  const first = vi.fn()
  const latest = vi.fn()
  const { rerender, unmount } = render(
    <StrictMode>
      <Element identity="file" attachment="first" onEvent={first} />
    </StrictMode>,
  )
  const acquired = emitters.length
  const retained = emitters[acquired - 1]!
  rerender(
    <StrictMode>
      <Element identity="file" attachment="first" onEvent={latest} />
    </StrictMode>,
  )
  expect(emitters).toHaveLength(acquired)
  retained('edit')
  rerender(
    <StrictMode>
      <Element identity="file" attachment="replacement" onEvent={latest} />
    </StrictMode>,
  )
  expect(emitters.length).toBeGreaterThan(acquired)
  retained('stale')
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledExactlyOnceWith('edit')
  unmount()
  expect(release).toHaveBeenCalledTimes(emitters.length)
  expect(latest).toHaveBeenCalledOnce()
})
