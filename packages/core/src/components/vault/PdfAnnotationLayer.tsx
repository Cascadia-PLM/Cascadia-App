// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useRef, useState } from 'react'
import { MessageSquare, Trash2 } from 'lucide-react'
import type {
  AnnotationGeometry,
  AnnotationKind,
  FileAnnotation,
  NormalizedPoint,
  NormalizedRect,
} from '@/lib/vault/annotations'
import { MIN_DRAG_EXTENT } from '@/lib/vault/annotations'
import { cn } from '@/lib/utils'

export type AnnotationTool = AnnotationKind | 'select'

interface PdfAnnotationLayerProps {
  pageNumber: number
  /** Rendered page size in CSS pixels, for sizing strokes and text. */
  pageWidth: number
  pageHeight: number
  annotations: Array<FileAnnotation>
  /** `select` or `null` means the layer is read-only and passes clicks through. */
  tool: AnnotationTool | null
  color: string
  onCreate: (pageNumber: number, geometry: AnnotationGeometry) => void
  onSelect: (annotation: FileAnnotation) => void
  onDelete: (annotation: FileAnnotation) => void
  /** Ids the caller considers editable by the current user. */
  deletableIds: ReadonlySet<string>
}

/** In-progress shape, before it is committed. */
type Draft =
  | { kind: 'rect'; start: NormalizedPoint; current: NormalizedPoint }
  | { kind: 'ink'; points: Array<NormalizedPoint> }

/**
 * The markup surface for one rendered PDF page.
 *
 * Sits above the pdf.js canvas and below nothing: when a drawing tool is
 * active it captures pointer events, and when it is not it sets
 * `pointer-events: none` so text selection and link clicks in the layers below
 * keep working. Existing markup is always visible either way.
 *
 * Everything is drawn in percentages of the layer's own box, which is exactly
 * the page box — so the same normalized geometry renders correctly at any zoom
 * and reproduces in a PDF stamped by a worker that never saw this viewport.
 */
export function PdfAnnotationLayer({
  pageNumber,
  pageWidth,
  pageHeight,
  annotations,
  tool,
  color,
  onCreate,
  onSelect,
  onDelete,
  deletableIds,
}: PdfAnnotationLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const isDrawing = tool !== null && tool !== 'select'

  const pointFromEvent = useCallback(
    (event: React.PointerEvent): NormalizedPoint | null => {
      const box = containerRef.current?.getBoundingClientRect()
      if (!box || box.width === 0 || box.height === 0) return null
      return {
        x: clamp01((event.clientX - box.left) / box.width),
        y: clamp01((event.clientY - box.top) / box.height),
      }
    },
    [],
  )

  const handlePointerDown = (event: React.PointerEvent) => {
    if (!isDrawing) return
    const point = pointFromEvent(event)
    if (!point) return

    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)

    // Point-anchored kinds commit immediately; the caller collects the text.
    if (tool === 'note') {
      onCreate(pageNumber, { kind: 'note', anchor: point })
      return
    }
    if (tool === 'text') {
      onCreate(pageNumber, { kind: 'text', anchor: point, fontSize: 0.018 })
      return
    }
    if (tool === 'ink') {
      setDraft({ kind: 'ink', points: [point] })
      return
    }
    setDraft({ kind: 'rect', start: point, current: point })
  }

  const handlePointerMove = (event: React.PointerEvent) => {
    if (!draft) return
    const point = pointFromEvent(event)
    if (!point) return

    setDraft((current) => {
      if (!current) return current
      if (current.kind === 'ink') {
        // Drop sub-pixel jitter: a 300-point stroke and a 30-point stroke look
        // identical, and the short one is a tenth of the payload.
        const last = current.points[current.points.length - 1]
        if (last && distance(last, point) < 0.002) return current
        return { ...current, points: [...current.points, point] }
      }
      return { ...current, current: point }
    })
  }

  const handlePointerUp = (event: React.PointerEvent) => {
    if (!draft) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    if (draft.kind === 'ink') {
      // A tap with the pen tool is a mis-click, not a one-point stroke.
      if (draft.points.length >= 2) {
        onCreate(pageNumber, {
          kind: 'ink',
          strokes: [draft.points],
          width: 0.003,
        })
      }
    } else {
      const rect = rectFrom(draft.start, draft.current)
      if (rect.width >= MIN_DRAG_EXTENT && rect.height >= MIN_DRAG_EXTENT) {
        onCreate(
          pageNumber,
          tool === 'rect'
            ? { kind: 'rect', rect }
            : { kind: 'highlight', rect },
        )
      }
    }

    setDraft(null)
  }

  const pageAnnotations = annotations.filter(
    (annotation) => annotation.pageNumber === pageNumber,
  )

  return (
    <div
      ref={containerRef}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      className={cn(
        // Above pdf.js's text layer, which sets `z-index: 2` and would
        // otherwise swallow every pointer event before a stroke could start.
        'absolute inset-0 z-10',
        isDrawing ? 'cursor-crosshair' : 'pointer-events-none',
      )}
      data-testid={`annotation-layer-${pageNumber}`}
    >
      {pageAnnotations.map((annotation) => (
        <AnnotationShape
          key={annotation.id}
          annotation={annotation}
          pageWidth={pageWidth}
          pageHeight={pageHeight}
          interactive={!isDrawing}
          deletable={deletableIds.has(annotation.id)}
          onSelect={onSelect}
          onDelete={onDelete}
        />
      ))}

      {draft && (
        <DraftShape
          draft={draft}
          tool={tool}
          color={color}
          pageWidth={pageWidth}
        />
      )}
    </div>
  )
}

function AnnotationShape({
  annotation,
  pageWidth,
  pageHeight,
  interactive,
  deletable,
  onSelect,
  onDelete,
}: {
  annotation: FileAnnotation
  pageWidth: number
  pageHeight: number
  interactive: boolean
  deletable: boolean
  onSelect: (annotation: FileAnnotation) => void
  onDelete: (annotation: FileAnnotation) => void
}) {
  const { geometry, color } = annotation
  const title = annotation.contents
    ? `${annotation.authorName ?? 'Unknown'}: ${annotation.contents}`
    : (annotation.authorName ?? 'Markup')

  // Re-enable pointer events per shape, so markup stays clickable even while
  // the layer as a whole is transparent to the text layer beneath it.
  const shell = interactive ? 'pointer-events-auto' : 'pointer-events-none'

  if (geometry.kind === 'highlight' || geometry.kind === 'rect') {
    const isHighlight = geometry.kind === 'highlight'
    return (
      <button
        type="button"
        title={title}
        onClick={() => onSelect(annotation)}
        style={{
          ...rectStyle(geometry.rect),
          backgroundColor: isHighlight ? color : 'transparent',
          opacity: isHighlight ? 0.35 : 1,
          border: isHighlight ? 'none' : `2px solid ${color}`,
        }}
        className={cn('absolute rounded-[2px]', shell)}
      />
    )
  }

  if (geometry.kind === 'ink') {
    return (
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className={cn('absolute inset-0 h-full w-full', shell)}
        onClick={() => onSelect(annotation)}
      >
        <title>{title}</title>
        {geometry.strokes.map((stroke, index) => (
          <polyline
            key={index}
            points={stroke.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            style={{ strokeWidth: strokePx(geometry.width, pageWidth) }}
          />
        ))}
      </svg>
    )
  }

  if (geometry.kind === 'note') {
    return (
      <div
        style={{
          left: `${geometry.anchor.x * 100}%`,
          top: `${geometry.anchor.y * 100}%`,
        }}
        className={cn(
          'group absolute -translate-x-1/2 -translate-y-1/2',
          shell,
        )}
      >
        <button
          type="button"
          title={title}
          onClick={() => onSelect(annotation)}
          style={{ backgroundColor: color }}
          className="flex h-6 w-6 items-center justify-center rounded-full text-slate-900 shadow ring-1 ring-black/20"
        >
          <MessageSquare className="h-3.5 w-3.5" />
        </button>
        {deletable && (
          <button
            type="button"
            title="Delete markup"
            onClick={() => onDelete(annotation)}
            className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-red-600 text-white group-hover:flex"
          >
            <Trash2 className="h-2.5 w-2.5" />
          </button>
        )}
      </div>
    )
  }

  return (
    <button
      type="button"
      title={title}
      onClick={() => onSelect(annotation)}
      style={{
        left: `${geometry.anchor.x * 100}%`,
        top: `${geometry.anchor.y * 100}%`,
        color,
        // Cap height is stored as a fraction of page height, so the label
        // keeps its size relative to the sheet at every zoom level.
        fontSize: `${Math.max(8, geometry.fontSize * pageHeight)}px`,
      }}
      className={cn(
        'absolute origin-top-left font-semibold whitespace-pre drop-shadow-sm',
        shell,
      )}
    >
      {annotation.contents ?? ''}
    </button>
  )
}

function DraftShape({
  draft,
  tool,
  color,
  pageWidth,
}: {
  draft: Draft
  tool: AnnotationTool | null
  color: string
  pageWidth: number
}) {
  if (draft.kind === 'ink') {
    return (
      <svg
        viewBox="0 0 1 1"
        preserveAspectRatio="none"
        className="pointer-events-none absolute inset-0 h-full w-full"
      >
        <polyline
          points={draft.points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ strokeWidth: strokePx(0.003, pageWidth) }}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    )
  }

  const rect = rectFrom(draft.start, draft.current)
  return (
    <div
      style={{
        ...rectStyle(rect),
        backgroundColor: tool === 'rect' ? 'transparent' : color,
        opacity: tool === 'rect' ? 1 : 0.35,
        border: tool === 'rect' ? `2px dashed ${color}` : 'none',
      }}
      className="pointer-events-none absolute rounded-[2px]"
    />
  )
}

function rectStyle(rect: NormalizedRect): React.CSSProperties {
  return {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  }
}

function rectFrom(a: NormalizedPoint, b: NormalizedPoint): NormalizedRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  }
}

/** Stroke width is stored relative to page width; render it in device pixels. */
function strokePx(width: number, pageWidth: number): number {
  return Math.max(1, width * pageWidth)
}

function distance(a: NormalizedPoint, b: NormalizedPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
