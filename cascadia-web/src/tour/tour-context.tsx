// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createTourController } from './tour-controller'
import { createDriverPresentation } from './adapters/driver-presentation'
import { createBrowserCompletionStore } from './adapters/browser-completion-store'
import type { ReactNode } from 'react'
import type { TourSnapshot } from './ports'

interface TourContextValue extends TourSnapshot {
  startTour: () => void
  resetTour: () => void
  triggerFirstTimeTour: () => () => void
}

const TourContext = createContext<TourContextValue | null>(null)
const reportTourError = (error: unknown) => console.warn('Guided tour:', error)
const noCancellation = () => undefined

export function TourProvider({
  children,
  enabled = true,
}: {
  children: ReactNode
  enabled?: boolean
}) {
  const [snapshot, setSnapshot] = useState<TourSnapshot>({
    hasCompletedTour: true,
    isTourActive: false,
  })
  const [completion] = useState(() =>
    createBrowserCompletionStore(reportTourError),
  )
  const controllerRef = useRef<ReturnType<typeof createTourController> | null>(
    null,
  )

  // Set up before dashboard passive effects. StrictMode creates a fresh owner
  // on its second setup; cleanup permanently closes the previous owner.
  useLayoutEffect(() => {
    if (!enabled) return
    let observing = true
    const controller = createTourController({
      presentation: createDriverPresentation,
      completion,
      onChange: (next) => {
        if (observing) setSnapshot(next)
      },
      onError: reportTourError,
    })
    controllerRef.current = controller
    setSnapshot(controller.snapshot())
    return () => {
      observing = false
      controllerRef.current = null
      void controller.dispose()
    }
  }, [enabled, completion])

  const startTour = useCallback(() => {
    controllerRef.current?.start()
  }, [])
  const resetTour = useCallback(() => {
    controllerRef.current?.reset()
  }, [])
  const triggerFirstTimeTour = useCallback(
    () =>
      enabled
        ? (controllerRef.current?.scheduleAutomaticStart() ?? noCancellation)
        : noCancellation,
    [enabled],
  )

  return (
    <TourContext.Provider
      value={{
        hasCompletedTour: snapshot.hasCompletedTour,
        isTourActive: enabled && snapshot.isTourActive,
        startTour,
        resetTour,
        triggerFirstTimeTour,
      }}
    >
      {children}
    </TourContext.Provider>
  )
}

export function useTour() {
  const context = useContext(TourContext)
  if (!context) throw new Error('useTour must be used within a TourProvider')
  return context
}
