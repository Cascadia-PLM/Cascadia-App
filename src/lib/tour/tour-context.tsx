import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import { driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { tourSteps } from './tour-steps'
import type { Driver } from 'driver.js'
import type { ReactNode } from 'react'

const TOUR_STORAGE_KEY = 'cascadia-tour-completed'

interface TourContextValue {
  hasCompletedTour: boolean
  isTourActive: boolean
  startTour: () => void
  resetTour: () => void
  triggerFirstTimeTour: () => void
}

const TourContext = createContext<TourContextValue | null>(null)

export function TourProvider({ children }: { children: ReactNode }) {
  const [hasCompletedTour, setHasCompletedTour] = useState(true) // Default to true to prevent flash
  const [isTourActive, setIsTourActive] = useState(false)
  const driverRef = useRef<Driver | null>(null)
  const hasCheckedStorage = useRef(false)

  // Check localStorage on mount (but don't auto-trigger - wait for login)
  useEffect(() => {
    if (hasCheckedStorage.current) return
    hasCheckedStorage.current = true

    const completed = localStorage.getItem(TOUR_STORAGE_KEY)
    const isCompleted = completed === 'true'
    setHasCompletedTour(isCompleted)
  }, [])

  const startTourInternal = useCallback(() => {
    // Create a new driver instance each time
    const driverInstance = driver({
      showProgress: true,
      showButtons: ['next', 'previous', 'close'],
      steps: tourSteps,
      popoverClass: 'cascadia-tour-popover',
      overlayColor: 'rgba(0, 0, 0, 0.75)',
      stagePadding: 8,
      stageRadius: 8,
      animate: true,
      allowClose: true,
      doneBtnText: 'Get Started',
      nextBtnText: 'Next',
      prevBtnText: 'Previous',
      onDestroyStarted: () => {
        // Mark tour as completed when user finishes or closes
        localStorage.setItem(TOUR_STORAGE_KEY, 'true')
        setHasCompletedTour(true)
        setIsTourActive(false)
        driverInstance.destroy()
      },
      onDestroyed: () => {
        setIsTourActive(false)
        driverRef.current = null
      },
    })

    driverRef.current = driverInstance
    setIsTourActive(true)
    driverInstance.drive()
  }, [])

  const startTour = useCallback(() => {
    // If already active, don't start again
    if (isTourActive) return

    startTourInternal()
  }, [isTourActive, startTourInternal])

  const resetTour = useCallback(() => {
    // Clear completion state and restart
    localStorage.removeItem(TOUR_STORAGE_KEY)
    setHasCompletedTour(false)
    startTourInternal()
  }, [startTourInternal])

  const triggerFirstTimeTour = useCallback(() => {
    // Skip tour in test mode (Playwright sets this via storageState)
    if (localStorage.getItem('cascadia-e2e-test') === 'true') return

    // Only trigger if user hasn't completed the tour before
    const completed = localStorage.getItem(TOUR_STORAGE_KEY)
    if (completed === 'true') return

    // Delay to allow the dashboard to render
    setTimeout(() => {
      startTourInternal()
    }, 1000)
  }, [startTourInternal])

  return (
    <TourContext.Provider
      value={{
        hasCompletedTour,
        isTourActive,
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
  if (!context) {
    throw new Error('useTour must be used within a TourProvider')
  }
  return context
}
