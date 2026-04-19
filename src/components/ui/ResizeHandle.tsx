/**
 * ResizeHandle - Draggable handle for resizing panels
 *
 * Place on the edge of a panel to allow drag-to-resize.
 */

import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'

interface ResizeHandleProps {
  /** Which side of the panel the handle is on */
  side: 'left' | 'right'
  /** Callback when width changes during drag */
  onResize: (width: number) => void
  /** Minimum width in pixels */
  minWidth?: number
  /** Maximum width in pixels */
  maxWidth?: number
  /** Current width for calculating delta */
  currentWidth: number
}

export function ResizeHandle({
  side,
  onResize,
  minWidth = 200,
  maxWidth = 600,
  currentWidth,
}: ResizeHandleProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [startX, setStartX] = useState(0)
  const [startWidth, setStartWidth] = useState(currentWidth)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setIsDragging(true)
      setStartX(e.clientX)
      setStartWidth(currentWidth)
    },
    [currentWidth],
  )

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const delta = e.clientX - startX
      // For left side handle, moving left increases width (negative delta = larger)
      // For right side handle, moving right increases width (positive delta = larger)
      const newWidth = side === 'left' ? startWidth - delta : startWidth + delta

      const clampedWidth = Math.min(maxWidth, Math.max(minWidth, newWidth))
      onResize(clampedWidth)
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, startX, startWidth, side, minWidth, maxWidth, onResize])

  // Set cursor style on body while dragging
  useEffect(() => {
    if (isDragging) {
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    } else {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isDragging])

  return (
    <div
      onMouseDown={handleMouseDown}
      className={cn(
        'absolute top-0 bottom-0 w-1 cursor-col-resize z-50',
        'hover:bg-cyan-500/50 transition-colors',
        isDragging && 'bg-cyan-500',
        side === 'left' ? 'left-0' : 'right-0',
      )}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
    />
  )
}
