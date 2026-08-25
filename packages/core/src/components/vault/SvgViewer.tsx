// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useMemo, useRef, useState } from 'react'
import {
  Maximize2,
  Minimize2,
  Move,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import {
  useFullscreen,
  useViewerZoom,
} from '@/components/vault/viewer-controls'

/**
 * Wraps the markup in a `data:` URL an `<img>` can load.
 *
 * **An object URL would not be equivalent, and the difference is the point.**
 * `URL.createObjectURL` mints a `blob:` URL that inherits *this app's* origin,
 * so a viewer who picks "Open image in new tab" loads the SVG as a top-level
 * document on Cascadia's origin — and a document, unlike an `<img>`, runs the
 * script an SVG is allowed to carry. A `data:` URL closes that off twice over:
 * browsers refuse top-level navigation to one, and a `data:` document gets an
 * opaque origin even when one is reached some other way.
 *
 * Percent-encoded rather than base64 because the source is already a string and
 * `btoa` throws on any code point above U+00FF — an SVG with a CJK or accented
 * `<text>` element is entirely ordinary.
 */
function toDataUrl(svgSource: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgSource)}`
}

interface SvgViewerProps {
  /** The SVG source, fetched as text. Never handed to `innerHTML`. */
  source: string
  fileName?: string
  /** Rendered to the right of the toolbar — typically a download button. */
  toolbarExtra?: React.ReactNode
  className?: string
}

/**
 * Embedded viewer for vector drawings: zoom, rotate, drag to pan, fullscreen.
 *
 * The markup is rendered by an `<img>`, which the SVG spec puts in secure
 * static mode — no script, no external references, no interactivity. That is
 * the whole reason this is a separate viewer rather than a branch of the image
 * case: an SVG needs a source that is safe to point an `<img>` at, and the
 * bytes arrive as text (see `preview.ts`) precisely so nothing en route is
 * tempted to treat them as markup.
 *
 * Zooming an `<img>` rather than re-rasterizing is enough because the browser
 * re-renders the vector at whatever size the element takes, so 4x is as crisp
 * as 1x — which is the reason anyone opens a drawing in a viewer at all.
 */
export function SvgViewer({
  source,
  fileName,
  toolbarExtra,
  className,
}: SvgViewerProps) {
  const [rotation, setRotation] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)

  const containerRef = useRef<HTMLDivElement>(null)
  // Where the pointer went down, and where the image already was, so a drag
  // moves by the delta instead of snapping the image under the cursor.
  const dragOrigin = useRef({ x: 0, y: 0, panX: 0, panY: 0 })

  const { zoom, stepZoom, resetZoom, canZoomIn, canZoomOut } = useViewerZoom()
  const { isFullscreen, toggleFullscreen } = useFullscreen(containerRef)

  const dataUrl = useMemo(() => toDataUrl(source), [source])

  const resetView = useCallback(() => {
    resetZoom()
    setPan({ x: 0, y: 0 })
    setRotation(0)
  }, [resetZoom])

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Left button only: middle and right belong to the browser's own
      // scroll and context menu.
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      dragOrigin.current = {
        x: event.clientX,
        y: event.clientY,
        panX: pan.x,
        panY: pan.y,
      }
      setIsPanning(true)
    },
    [pan.x, pan.y],
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isPanning) return
      const origin = dragOrigin.current
      setPan({
        x: origin.panX + (event.clientX - origin.x),
        y: origin.panY + (event.clientY - origin.y),
      })
    },
    [isPanning],
  )

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isPanning) return
      event.currentTarget.releasePointerCapture(event.pointerId)
      setIsPanning(false)
    },
    [isPanning],
  )

  return (
    <div
      ref={containerRef}
      className={cn(
        'flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-slate-100 dark:border-slate-700 dark:bg-slate-900',
        isFullscreen && 'h-screen rounded-none',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-1 border-b border-slate-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-800">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => stepZoom(-1)}
          disabled={!canZoomOut}
          title="Zoom out"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <button
          type="button"
          onClick={resetView}
          className="min-w-14 rounded px-1 text-sm text-slate-600 tabular-nums hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
          title="Reset view"
        >
          {Math.round(zoom * 100)}%
        </button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => stepZoom(1)}
          disabled={!canZoomIn}
          title="Zoom in"
          aria-label="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setRotation((r) => (r + 90) % 360)}
          title="Rotate 90°"
          aria-label="Rotate 90 degrees"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? (
            <Minimize2 className="h-4 w-4" />
          ) : (
            <Maximize2 className="h-4 w-4" />
          )}
        </Button>

        <span className="ml-1 hidden items-center gap-1 text-xs text-slate-500 sm:flex dark:text-slate-400">
          <Move className="h-3 w-3" />
          Drag to pan
        </span>

        <div className="ml-auto flex items-center gap-1">{toolbarExtra}</div>
      </div>

      <div
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className={cn(
          'flex flex-1 touch-none items-center justify-center overflow-hidden p-4',
          isPanning ? 'cursor-grabbing' : 'cursor-grab',
        )}
      >
        <img
          src={dataUrl}
          alt={fileName ?? 'Vector drawing'}
          draggable={false}
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${rotation}deg)`,
          }}
          // `max-*` keeps the drawing inside the frame at 1x whatever its
          // intrinsic size; the transform then scales from there, so "100%"
          // always means "fits the panel".
          //
          // Zoom and rotate ease; panning must not. A transition on transform
          // makes a drag chase the cursor a tenth of a second behind, which
          // reads as lag rather than as polish.
          className={cn(
            'max-h-full max-w-full object-contain',
            !isPanning && 'transition-transform duration-100',
          )}
        />
      </div>
    </div>
  )
}
