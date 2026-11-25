// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { StrictMode, useEffect } from 'react'
import { act, cleanup, render, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TourProvider, useTour } from './tour-context'
import type { ReactNode } from 'react'

function AutoTour() {
  const { triggerFirstTimeTour } = useTour()
  useEffect(() => triggerFirstTimeTour(), [triggerFirstTimeTour])
  return null
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <TourProvider>{children}</TourProvider>
)
beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  cleanup()
  document
    .querySelectorAll('.driver-popover, .driver-overlay, #driver-dummy-element')
    .forEach((element) => element.remove())
  document.body.classList.remove('driver-active')
  vi.useRealTimers()
})
describe('guided tour lifecycle', () => {
  it('keeps a manual start from racing the pending automatic start', () => {
    const { result } = renderHook(() => useTour(), { wrapper })
    act(() => {
      result.current.triggerFirstTimeTour()
      result.current.startTour()
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(1)
  })
  it('closes an active tour on setup without recording completion', () => {
    const view = render(
      <TourProvider>
        <AutoTour />
      </TourProvider>,
    )
    act(() => vi.advanceTimersByTime(1000))
    view.rerender(
      <TourProvider enabled={false}>
        <div>Setup</div>
      </TourProvider>,
    )
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(0)
    expect(localStorage.getItem('cascadia-tour-completed')).toBeNull()
  })
  it('does not start on setup but can start after returning to the dashboard', () => {
    const view = render(
      <TourProvider enabled={false}>
        <AutoTour />
      </TourProvider>,
    )
    act(() => vi.advanceTimersByTime(1000))
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(0)
    view.rerender(
      <TourProvider>
        <AutoTour />
      </TourProvider>,
    )
    act(() => vi.advanceTimersByTime(1000))
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(1)
  })
  it('records completion when the user closes the tour and does not reopen it', () => {
    const { result } = renderHook(() => useTour(), { wrapper })
    act(() => result.current.startTour())
    act(() =>
      (
        document.querySelector('.driver-popover-close-btn') as HTMLButtonElement
      ).click(),
    )
    expect(localStorage.getItem('cascadia-tour-completed')).toBe('true')
    act(() => {
      result.current.triggerFirstTimeTour()
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(0)
  })
  it('opens one welcome popup under React StrictMode', () => {
    render(
      <StrictMode>
        <TourProvider>
          <AutoTour />
        </TourProvider>
      </StrictMode>,
    )
    act(() => vi.advanceTimersByTime(1000))
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(1)
  })
  it('coalesces manual starts before React commits the active state', () => {
    const { result } = renderHook(() => useTour(), { wrapper })
    act(() => {
      result.current.startTour()
      result.current.startTour()
    })
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(1)
  })
  it('cancels automatic startup when the dashboard unmounts', () => {
    const view = render(
      <TourProvider>
        <AutoTour />
      </TourProvider>,
    )
    view.rerender(
      <TourProvider>
        <div>Setup</div>
      </TourProvider>,
    )
    act(() => vi.advanceTimersByTime(1000))
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(0)
    expect(localStorage.getItem('cascadia-tour-completed')).toBeNull()
  })
  it('does not let stale cleanup cancel a replacement automatic start', () => {
    const { result } = renderHook(() => useTour(), { wrapper })
    act(() => {
      const oldCleanup = result.current.triggerFirstTimeTour()
      oldCleanup()
      result.current.triggerFirstTimeTour()
      oldCleanup()
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(1)
  })
  it('gives duplicate requests no authority over the original request', () => {
    const { result } = renderHook(() => useTour(), { wrapper })
    act(() => {
      result.current.triggerFirstTimeTour()
      const duplicateCleanup = result.current.triggerFirstTimeTour()
      duplicateCleanup()
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(1)
  })
  it.each(['startTour', 'resetTour', 'triggerFirstTimeTour'] as const)(
    'rejects retained %s after provider unmount',
    (command) => {
      const { result, unmount } = renderHook(() => useTour(), { wrapper })
      const retained = result.current
      unmount()
      act(() => {
        retained[command]()
        vi.advanceTimersByTime(1000)
      })
      expect(document.querySelectorAll('.driver-popover')).toHaveLength(0)
      expect(localStorage.getItem('cascadia-tour-completed')).toBeNull()
    },
  )
  it('closes and remembers acknowledgement when browser persistence fails', () => {
    localStorage.setItem('cascadia-tour-completed', 'false')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { result } = renderHook(() => useTour(), { wrapper })
    act(() => result.current.startTour())
    act(() =>
      (
        document.querySelector('.driver-popover-close-btn') as HTMLButtonElement
      ).click(),
    )
    expect(result.current.hasCompletedTour).toBe(true)
    act(() => {
      result.current.triggerFirstTimeTour()
      vi.advanceTimersByTime(1000)
    })
    expect(document.querySelectorAll('.driver-popover')).toHaveLength(0)
  })
})
