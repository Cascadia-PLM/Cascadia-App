import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'

// Default widths in pixels
const DEFAULT_OPEN_WIDTH = 320 // 20rem
const COLLAPSED_WIDTH = 64 // 4rem
const MIN_WIDTH = 200
const MAX_WIDTH = 500

interface SidebarContextType {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  isPinned: boolean
  setIsPinned: (pinned: boolean) => void
  width: number
  setWidth: (width: number) => void
  collapsedWidth: number
}

const SidebarContext = createContext<SidebarContextType | null>(null)

export function SidebarProvider({ children }: { children: ReactNode }) {
  const [isPinned, setIsPinned] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('nav-pinned') === 'true'
    }
    return false
  })
  const [isOpen, setIsOpen] = useState(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('nav-pinned') === 'true'
    }
    return false
  })
  const [width, setWidthState] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('nav-width')
      if (stored) {
        const parsed = parseInt(stored, 10)
        if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
          return parsed
        }
      }
    }
    return DEFAULT_OPEN_WIDTH
  })

  // Persist pinned state
  useEffect(() => {
    localStorage.setItem('nav-pinned', String(isPinned))
  }, [isPinned])

  // Persist width
  const setWidth = (newWidth: number) => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
    setWidthState(clamped)
    localStorage.setItem('nav-width', String(clamped))
  }

  return (
    <SidebarContext.Provider
      value={{
        isOpen,
        setIsOpen,
        isPinned,
        setIsPinned,
        width,
        setWidth,
        collapsedWidth: COLLAPSED_WIDTH,
      }}
    >
      {children}
    </SidebarContext.Provider>
  )
}

export { MIN_WIDTH as SIDEBAR_MIN_WIDTH, MAX_WIDTH as SIDEBAR_MAX_WIDTH }

export function useSidebar() {
  const context = useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider')
  }
  return context
}
