import { useCallback, useEffect, useRef } from 'react'
import { Menu, Pin, PinOff } from 'lucide-react'
import { SidebarNav } from './SidebarNav'
import type { SidebarProps } from './types'
import {
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useSidebar,
} from '@/lib/sidebar-context'
import { ResizeHandle } from '@/components/ui/ResizeHandle'

export function Sidebar({ currentPath }: SidebarProps) {
  const {
    isOpen,
    setIsOpen,
    isPinned,
    setIsPinned,
    width,
    setWidth,
    collapsedWidth,
  } = useSidebar()
  const sidebarRef = useRef<HTMLElement>(null)

  // Icon size: larger when collapsed for better visibility
  const iconSize = isOpen ? 20 : 24

  // Close sidebar when clicking outside (only if not pinned)
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        !isPinned &&
        isOpen &&
        sidebarRef.current &&
        !sidebarRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isPinned, isOpen, setIsOpen])

  // Close sidebar on navigation (only if not pinned)
  const handleNavClick = useCallback(() => {
    if (!isPinned) {
      setIsOpen(false)
    }
  }, [isPinned, setIsOpen])

  // Current width based on open state
  const currentWidth = isOpen ? width : collapsedWidth

  return (
    <aside
      ref={sidebarRef}
      className="fixed top-0 left-0 h-full bg-white dark:bg-slate-950 text-gray-900 dark:text-white shadow-lg z-50 flex flex-col transition-all duration-300 ease-in-out"
      style={{ width: currentWidth }}
    >
      {/* Resize handle on right edge - only when open */}
      {isOpen && (
        <ResizeHandle
          side="right"
          currentWidth={width}
          onResize={setWidth}
          minWidth={SIDEBAR_MIN_WIDTH}
          maxWidth={SIDEBAR_MAX_WIDTH}
        />
      )}

      <div
        className={`flex items-center border-b border-gray-300 dark:border-gray-700 h-12 ${
          isOpen ? 'justify-between px-4' : 'justify-center px-2'
        }`}
      >
        {isOpen && <h2 className="text-xl font-bold">Navigation</h2>}
        <div className="flex items-center gap-1">
          {isOpen && (
            <button
              onClick={() => setIsPinned(!isPinned)}
              className={`p-1.5 rounded-lg transition-colors ${
                isPinned
                  ? 'bg-cyan-100 dark:bg-cyan-900/50 text-cyan-600 dark:text-cyan-400'
                  : 'hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
              aria-label={isPinned ? 'Unpin menu' : 'Pin menu'}
              title={isPinned ? 'Unpin menu' : 'Pin menu open'}
            >
              {isPinned ? <Pin size={20} /> : <PinOff size={20} />}
            </button>
          )}
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors"
            aria-label={isOpen ? 'Collapse menu' : 'Expand menu'}
            title={isOpen ? 'Collapse menu' : 'Expand menu'}
            data-testid="menu-button"
          >
            <Menu size={20} />
          </button>
        </div>
      </div>

      <nav
        className={`flex-1 auto-hide-scroll ${isOpen ? 'p-4' : 'p-2'}`}
        data-testid="main-nav"
      >
        <SidebarNav
          isOpen={isOpen}
          onNavClick={handleNavClick}
          currentPath={currentPath}
          iconSize={iconSize}
        />
      </nav>
    </aside>
  )
}
