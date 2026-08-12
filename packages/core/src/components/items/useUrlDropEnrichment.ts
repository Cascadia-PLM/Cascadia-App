// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useRef, useState } from 'react'
import { apiPost } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

export interface UrlEnrichmentResult {
  aiEnabled: boolean
  link: string
  fields: Record<string, unknown>
  attributes: Record<string, string>
}

interface UseUrlDropEnrichmentOptions {
  itemType: 'Part' | 'Tool'
  /** When false, all drop handlers are inert (e.g. edit mode). */
  enabled: boolean
  /** Called with the server's suggestions to merge into form state. */
  onEnriched: (result: UrlEnrichmentResult) => void
}

interface UseUrlDropEnrichmentResult {
  isDragging: boolean
  isEnriching: boolean
  dropHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

/** A drag carrying a link/text (not files) can be enriched. */
function dragHasUrl(e: React.DragEvent): boolean {
  const types = Array.from(e.dataTransfer.types)
  return types.includes('text/uri-list') || types.includes('text/plain')
}

/** Pull a usable URL out of a drop's dataTransfer, if any. */
function extractUrl(dataTransfer: DataTransfer): string | null {
  const uriList = dataTransfer.getData('text/uri-list')
  if (uriList) {
    const firstUrl = uriList
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('#'))
    if (firstUrl) return firstUrl
  }
  const text = dataTransfer.getData('text/plain').trim()
  return text.length > 0 ? text : null
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Drag-and-drop a web link onto a create form to auto-fill it. The drop calls
 * the server enrichment endpoint and hands the result back via `onEnriched`.
 * File drops are ignored (they bubble to any underlying upload zone).
 */
export function useUrlDropEnrichment({
  itemType,
  enabled,
  onEnriched,
}: UseUrlDropEnrichmentOptions): UseUrlDropEnrichmentResult {
  const { handleError, showWarning } = useErrorHandler()
  const [isDragging, setIsDragging] = useState(false)
  const [isEnriching, setIsEnriching] = useState(false)
  // Depth counter so entering/leaving child elements doesn't flicker the overlay.
  const dragDepth = useRef(0)

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !dragHasUrl(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setIsDragging(true)
    },
    [enabled],
  )

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !dragHasUrl(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [enabled],
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !dragHasUrl(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setIsDragging(false)
    },
    [enabled],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !dragHasUrl(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setIsDragging(false)

      const url = extractUrl(e.dataTransfer)
      if (!url || !isHttpUrl(url)) {
        showWarning(
          'Not a valid link',
          'Drop a web link (http or https) to auto-fill the form.',
        )
        return
      }

      setIsEnriching(true)
      void apiPost<{ data: UrlEnrichmentResult }>(
        '/api/v1/items/enrich-from-url',
        {
          url,
          itemType,
        },
      )
        .then((response) => onEnriched(response.data))
        .catch((error) =>
          handleError(error, { title: 'Could not read the link' }),
        )
        .finally(() => setIsEnriching(false))
    },
    [enabled, itemType, onEnriched, handleError, showWarning],
  )

  return {
    isDragging,
    isEnriching,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
