/**
 * ChatPanelButton - Edge button to open AI chat panel
 *
 * Positioned on the right side of the screen, vertically centered.
 * Slides out when panel is open.
 */

import { ChevronLeft, MessageSquare } from 'lucide-react'
import { useChatPanel } from '@/lib/ai/chat-context'
import { cn } from '@/lib/utils'

export function ChatPanelButton() {
  const { toggleOpen, isOpen } = useChatPanel()

  return (
    <button
      onClick={toggleOpen}
      className={cn(
        // Position on right edge, vertically centered
        'fixed right-0 top-1/2 -translate-y-1/2 z-50',
        // Tab shape: rounded on left side only
        'flex h-24 w-10 items-center justify-center',
        'rounded-l-lg bg-cyan-600 text-white shadow-lg',
        'transition-all duration-300 ease-in-out',
        'hover:bg-cyan-700 hover:w-12',
        'focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:ring-offset-2',
        'dark:bg-cyan-700 dark:hover:bg-cyan-600',
        // Slide with the panel when open
        isOpen && 'translate-x-full opacity-0 pointer-events-none',
      )}
      aria-label={isOpen ? 'Close Cascadia Chat' : 'Open Cascadia Chat'}
    >
      <div className="flex flex-col items-center gap-1">
        <MessageSquare className="h-5 w-5" />
        <ChevronLeft className="h-4 w-4" />
      </div>
    </button>
  )
}
