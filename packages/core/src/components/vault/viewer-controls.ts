// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'

/**
 * Chrome shared by the in-app file viewers.
 *
 * Extracted when the SVG viewer arrived rather than copied: someone reading a
 * drawing set flips between a PDF and an SVG in the same panel, and a zoom
 * button that steps differently between the two reads as a bug.
 */

/**
 * Zoom stops, rather than a continuous scale. Discrete steps mean the reset
 * button has an unambiguous target and repeated clicks land on round numbers.
 */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
export const MIN_ZOOM = Math.min(...ZOOM_STEPS)
export const MAX_ZOOM = Math.max(...ZOOM_STEPS)

export interface ViewerZoom {
  zoom: number
  /** Step to the next stop up (`1`) or down (`-1`); a no-op at the ends. */
  stepZoom: (direction: 1 | -1) => void
  /** Back to 1x — "fit", since every viewer lays out at 1x to fit its box. */
  resetZoom: () => void
  canZoomIn: boolean
  canZoomOut: boolean
}

export function useViewerZoom(): ViewerZoom {
  const [zoom, setZoom] = useState(1)

  const stepZoom = useCallback((direction: 1 | -1) => {
    setZoom((current) => {
      const next =
        direction === 1
          ? ZOOM_STEPS.find((step) => step > current + 0.001)
          : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001)
      return next ?? current
    })
  }, [])

  const resetZoom = useCallback(() => setZoom(1), [])

  return {
    zoom,
    stepZoom,
    resetZoom,
    canZoomIn: zoom < MAX_ZOOM,
    canZoomOut: zoom > MIN_ZOOM,
  }
}

/**
 * Fullscreen state for one element, tracked from the `fullscreenchange` event
 * rather than from the click: Escape and the browser's own chrome exit
 * fullscreen without going through the toggle.
 */
export function useFullscreen(target: RefObject<HTMLElement | null>): {
  isFullscreen: boolean
  toggleFullscreen: () => void
} {
  const [isFullscreen, setIsFullscreen] = useState(false)

  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === target.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [target])

  const toggleFullscreen = useCallback(() => {
    const element = target.current
    if (!element) return
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void element.requestFullscreen()
    }
  }, [target])

  return { isFullscreen, toggleFullscreen }
}
