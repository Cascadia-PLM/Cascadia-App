import { useEffect } from 'react'
import type { StandardView } from './CADViewerTypes'

interface KeyboardActions {
  resetView: () => void
  toggleWireframe: () => void
  toggleFullscreen: () => void
  toggleGrid: () => void
  setView: (view: StandardView) => void
}

const VIEW_KEY_MAP: Record<string, StandardView> = {
  '1': 'front',
  '2': 'back',
  '3': 'left',
  '4': 'right',
  '5': 'top',
  '6': 'bottom',
  '0': 'iso',
}

const SKIP_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

export function useCADViewerKeyboard(
  containerRef: React.RefObject<HTMLElement | null>,
  actions: KeyboardActions,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if typing in form elements
      const target = e.target as HTMLElement
      if (SKIP_TAGS.has(target.tagName)) return

      // Only respond when pointer is over or focus is within the container
      const container = containerRef.current
      if (!container) return
      if (
        !container.matches(':hover') &&
        !container.contains(document.activeElement)
      ) {
        return
      }

      const key = e.key.toLowerCase()

      if (key === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        actions.resetView()
      } else if (key === 'w' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        actions.toggleWireframe()
      } else if (key === 'f' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        actions.toggleFullscreen()
      } else if (key === 'g' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        actions.toggleGrid()
      } else if (VIEW_KEY_MAP[e.key]) {
        e.preventDefault()
        actions.setView(VIEW_KEY_MAP[e.key])
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [containerRef, actions, enabled])
}
