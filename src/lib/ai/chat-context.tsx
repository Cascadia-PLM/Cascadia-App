/**
 * Chat Panel Context
 *
 * Provides state management for the AI chat panel sidebar.
 */

import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'

// Default widths in pixels
const DEFAULT_WIDTH = 400
const MIN_WIDTH = 300
const MAX_WIDTH = 700

interface ChatPanelContextType {
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  toggleOpen: () => void
  currentSessionId: string | undefined
  setCurrentSessionId: (sessionId: string | undefined) => void
  width: number
  setWidth: (width: number) => void
}

const ChatPanelContext = createContext<ChatPanelContextType | undefined>(
  undefined,
)

interface ChatPanelProviderProps {
  children: ReactNode
}

export function ChatPanelProvider({ children }: ChatPanelProviderProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<string | undefined>(
    undefined,
  )
  const [width, setWidthState] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('chat-panel-width')
      if (stored) {
        const parsed = parseInt(stored, 10)
        if (!isNaN(parsed) && parsed >= MIN_WIDTH && parsed <= MAX_WIDTH) {
          return parsed
        }
      }
    }
    return DEFAULT_WIDTH
  })

  const toggleOpen = useCallback(() => {
    setIsOpen((prev) => !prev)
  }, [])

  // Persist width
  const setWidth = (newWidth: number) => {
    const clamped = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, newWidth))
    setWidthState(clamped)
    localStorage.setItem('chat-panel-width', String(clamped))
  }

  return (
    <ChatPanelContext.Provider
      value={{
        isOpen,
        setIsOpen,
        toggleOpen,
        currentSessionId,
        setCurrentSessionId,
        width,
        setWidth,
      }}
    >
      {children}
    </ChatPanelContext.Provider>
  )
}

export { MIN_WIDTH as CHAT_PANEL_MIN_WIDTH, MAX_WIDTH as CHAT_PANEL_MAX_WIDTH }

export function useChatPanel() {
  const context = useContext(ChatPanelContext)
  if (context === undefined) {
    throw new Error('useChatPanel must be used within a ChatPanelProvider')
  }
  return context
}
