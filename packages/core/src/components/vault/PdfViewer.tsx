// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Document, Page, pdfjs } from 'react-pdf'
import {
  ChevronLeft,
  ChevronRight,
  Highlighter,
  Loader2,
  Maximize2,
  MessageSquarePlus,
  Minimize2,
  MousePointer2,
  Pencil,
  RotateCw,
  Square,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type {
  AnnotationGeometry,
  FileAnnotation,
} from '@/lib/vault/annotations'
import type { AnnotationTool } from '@/components/vault/PdfAnnotationLayer'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { ANNOTATION_COLORS } from '@/lib/vault/annotations'
import { PdfAnnotationLayer } from '@/components/vault/PdfAnnotationLayer'
import {
  useFullscreen,
  useViewerZoom,
} from '@/components/vault/viewer-controls'

import 'react-pdf/dist/Page/AnnotationLayer.css'
import 'react-pdf/dist/Page/TextLayer.css'

// pdf.js parses in a worker so a large document never blocks the UI thread.
// Bundled through Vite rather than fetched from a CDN — Cascadia has to work
// in air-gapped deployments.
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

/**
 * Character maps and the Base-14 font data, copied into the build by
 * `vite-plugin-static-copy`. Without these, a PDF that references a standard
 * font without embedding it (very common in exported drawings) renders with
 * missing glyphs, and CJK text does not render at all.
 */
const PDFJS_OPTIONS = {
  cMapUrl: '/pdfjs/cmaps/',
  cMapPacked: true,
  standardFontDataUrl: '/pdfjs/standard_fonts/',
} as const

/**
 * `select` first so the default state is "read, don't draw" — a viewer that
 * starts armed leaves stray marks the first time someone drags to scroll.
 */
const MARKUP_TOOLS = [
  { tool: 'select', label: 'Select', Icon: MousePointer2 },
  { tool: 'highlight', label: 'Highlight', Icon: Highlighter },
  { tool: 'rect', label: 'Box', Icon: Square },
  { tool: 'ink', label: 'Freehand', Icon: Pencil },
  { tool: 'note', label: 'Comment', Icon: MessageSquarePlus },
  { tool: 'text', label: 'Text label', Icon: Type },
] as const satisfies ReadonlyArray<{
  tool: AnnotationTool
  label: string
  Icon: typeof MousePointer2
}>

/**
 * Everything the viewer needs to show and capture markup. Absent when the
 * caller does not do markup at all (a preview dialog on a deleted item, say),
 * which is different from present-but-read-only (`canAnnotate: false`).
 */
export interface PdfMarkupBinding {
  annotations: Array<FileAnnotation>
  /** False renders existing markup but refuses new strokes. */
  canAnnotate: boolean
  tool: AnnotationTool
  color: string
  deletableIds: ReadonlySet<string>
  onCreate: (pageNumber: number, geometry: AnnotationGeometry) => void
  onSelect: (annotation: FileAnnotation) => void
  onDelete: (annotation: FileAnnotation) => void
  onToolChange: (tool: AnnotationTool) => void
  onColorChange: (color: string) => void
  /** Shown in place of the tools when markup is blocked, e.g. "check out to mark up". */
  disabledReason?: string | null
}

interface PdfViewerProps {
  /** Object URL or path the document is fetched from. */
  fileUrl: string
  fileName?: string
  /** Rendered to the right of the toolbar — typically a download button. */
  toolbarExtra?: React.ReactNode
  markup?: PdfMarkupBinding
  className?: string
  onError?: (error: Error) => void
}

/**
 * Embedded PDF viewer, rendered on canvas by pdf.js with a selectable text
 * layer over the top.
 *
 * Pages render as they scroll into view rather than all at once, so opening a
 * 300-page assembly manual costs the same as opening a one-page certificate.
 */
export function PdfViewer({
  fileUrl,
  fileName,
  toolbarExtra,
  markup,
  className,
  onError,
}: PdfViewerProps) {
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(1)
  const [rotation, setRotation] = useState(0)
  const [containerWidth, setContainerWidth] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // Rendered size per page, recorded as each finishes, so the markup surface
  // can convert normalized geometry to pixels without re-measuring the DOM.
  const [pageSizes, setPageSizes] = useState<
    Record<number, { width: number; height: number }>
  >({})

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pageRefs = useRef<Array<HTMLDivElement | null>>([])

  const { zoom, stepZoom, resetZoom, canZoomIn, canZoomOut } = useViewerZoom()
  const { isFullscreen, toggleFullscreen } = useFullscreen(containerRef)

  // Track the scroll container's width so pages can be laid out to fit it.
  useEffect(() => {
    const element = scrollRef.current
    if (!element) return

    const observer = new ResizeObserver(([entry]) => {
      if (entry) setContainerWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // A new document invalidates every page-scoped piece of state.
  useEffect(() => {
    setPageCount(0)
    setCurrentPage(1)
    setError(null)
    setPageSizes({})
    pageRefs.current = []
  }, [fileUrl])

  // Typed structurally rather than against react-pdf's `PageCallback`, which
  // the package does not re-export from its entry point.
  const handlePageRendered = useCallback(
    (pageNumber: number, page: { width: number; height: number }) => {
      setPageSizes((current) => {
        const existing = current[pageNumber]
        if (
          existing &&
          existing.width === page.width &&
          existing.height === page.height
        ) {
          return current
        }
        return {
          ...current,
          [pageNumber]: { width: page.width, height: page.height },
        }
      })
    },
    [],
  )

  const handleLoadSuccess = useCallback(
    ({ numPages }: { numPages: number }) => {
      setPageCount(numPages)
      pageRefs.current = new Array<HTMLDivElement | null>(numPages).fill(null)
    },
    [],
  )

  const handleLoadError = useCallback(
    (loadError: Error) => {
      setError(loadError.message)
      onError?.(loadError)
    },
    [onError],
  )

  // Report the page filling most of the viewport, so the counter tracks
  // free scrolling as well as the prev/next buttons.
  const handleScroll = useCallback(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    const midpoint = scroller.scrollTop + scroller.clientHeight / 2
    let visible = 1
    for (const [index, page] of pageRefs.current.entries()) {
      if (page && page.offsetTop <= midpoint) visible = index + 1
    }
    setCurrentPage(visible)
  }, [])

  const goToPage = useCallback(
    (page: number) => {
      const clamped = Math.min(Math.max(page, 1), Math.max(pageCount, 1))
      setCurrentPage(clamped)
      pageRefs.current[clamped - 1]?.scrollIntoView({ block: 'start' })
    },
    [pageCount],
  )

  // Fit the page to the container, leaving room for the scrollbar and padding,
  // then apply the user's zoom on top. Capped so a narrow panel does not blow
  // a 4x zoom up to an unrenderable canvas.
  const pageWidth = useMemo(() => {
    if (containerWidth === 0) return undefined
    return Math.max((containerWidth - 48) * zoom, 200)
  }, [containerWidth, zoom])

  const documentOptions = useMemo(() => PDFJS_OPTIONS, [])

  if (error !== null) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 py-12 text-center',
          className,
        )}
      >
        <p className="text-red-600 dark:text-red-400">
          This PDF could not be displayed
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400">{error}</p>
      </div>
    )
  }

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
          onClick={() => goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          title="Previous page"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="min-w-24 text-center text-sm text-slate-600 tabular-nums dark:text-slate-400">
          {pageCount > 0 ? `${currentPage} / ${pageCount}` : '--'}
        </span>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => goToPage(currentPage + 1)}
          disabled={pageCount === 0 || currentPage >= pageCount}
          title="Next page"
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>

        <div className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />

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
          onClick={resetZoom}
          className="min-w-14 rounded px-1 text-sm text-slate-600 tabular-nums hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-700"
          title="Reset zoom to fit width"
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

        {markup && (
          <>
            <div className="mx-1 h-5 w-px bg-slate-200 dark:bg-slate-700" />
            {markup.canAnnotate ? (
              <>
                {MARKUP_TOOLS.map(({ tool, label, Icon }) => (
                  <Button
                    key={tool}
                    variant="ghost"
                    size="icon"
                    onClick={() => markup.onToolChange(tool)}
                    aria-pressed={markup.tool === tool}
                    title={label}
                    aria-label={label}
                    className={cn(
                      markup.tool === tool &&
                        'bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-200',
                    )}
                  >
                    <Icon className="h-4 w-4" />
                  </Button>
                ))}
                <div className="ml-1 flex items-center gap-1">
                  {ANNOTATION_COLORS.map((swatch) => (
                    <button
                      key={swatch.value}
                      type="button"
                      onClick={() => markup.onColorChange(swatch.value)}
                      aria-pressed={markup.color === swatch.value}
                      title={swatch.label}
                      aria-label={swatch.label}
                      style={{ backgroundColor: swatch.value }}
                      className={cn(
                        'h-4 w-4 rounded-full ring-1 ring-black/20',
                        markup.color === swatch.value &&
                          'ring-2 ring-slate-900 dark:ring-white',
                      )}
                    />
                  ))}
                </div>
              </>
            ) : (
              markup.disabledReason && (
                <span className="px-1 text-xs text-slate-500 dark:text-slate-400">
                  {markup.disabledReason}
                </span>
              )
            )}
          </>
        )}

        <div className="ml-auto flex items-center gap-1">{toolbarExtra}</div>
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto p-4"
      >
        <Document
          file={fileUrl}
          onLoadSuccess={handleLoadSuccess}
          onLoadError={handleLoadError}
          options={documentOptions}
          externalLinkTarget="_blank"
          loading={
            <div className="flex items-center justify-center gap-2 py-12 text-slate-600 dark:text-slate-400">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Loading {fileName ?? 'document'}...</span>
            </div>
          }
          error={
            <div className="py-12 text-center text-red-600 dark:text-red-400">
              This PDF could not be displayed
            </div>
          }
          className="flex flex-col items-center gap-4"
        >
          {Array.from({ length: pageCount }, (_, index) => {
            const number = index + 1
            const size = pageSizes[number]
            return (
              <div
                key={`page-${number}`}
                ref={(element) => {
                  pageRefs.current[index] = element
                }}
                className="relative shadow-lg"
              >
                <Page
                  pageNumber={number}
                  width={pageWidth}
                  rotate={rotation}
                  renderTextLayer={true}
                  renderAnnotationLayer={true}
                  onRenderSuccess={(page) => handlePageRendered(number, page)}
                />
                {/* Only mount the markup surface once the page has rendered:
                    before then there is no page box to normalize against. */}
                {markup && size && (
                  <PdfAnnotationLayer
                    pageNumber={number}
                    pageWidth={size.width}
                    pageHeight={size.height}
                    annotations={markup.annotations}
                    tool={markup.canAnnotate ? markup.tool : null}
                    color={markup.color}
                    deletableIds={markup.deletableIds}
                    onCreate={markup.onCreate}
                    onSelect={markup.onSelect}
                    onDelete={markup.onDelete}
                  />
                )}
              </div>
            )
          })}
        </Document>
      </div>
    </div>
  )
}
