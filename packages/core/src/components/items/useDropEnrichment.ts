// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useRef, useState } from 'react'
import { readTransferSources, transferHasSources } from './enrichment-sources'
import { prepareImageForAi } from './image-payload'
import type { EnrichmentSources } from './enrichment-sources'
import type { EnrichmentImage } from '@/lib/items/enrichment/limits'
import { apiPost } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { MAX_ENRICHMENT_IMAGES } from '@/lib/items/enrichment/limits'

/**
 * `POST /api/v1/items/enrich` response. Mirrors `ItemEnrichmentResult` in
 * `lib/items/enrichment/enrich-item.ts`.
 */
export interface EnrichmentResult {
  aiEnabled: boolean
  /** The source URL when one was dropped, to keep as provenance. */
  link?: string
  fields: Record<string, unknown>
  attributes: Record<string, string>
  /** Tool only: capabilities for the suggested subtype. */
  capabilities?: Record<string, unknown>
  attributesTruncated?: boolean
  /** The model was called and failed — not the same as finding nothing. */
  extractionFailed?: boolean
  /** Why the link contributed nothing, when it was valid but unfetchable. */
  warning?: string
}

export type EnrichmentKind = 'link' | 'image'

interface UseDropEnrichmentOptions {
  itemType: 'Part' | 'Tool'
  /** When false, all handlers are inert (e.g. edit mode). */
  enabled: boolean
  /**
   * Called with the server's suggestions and what was dropped — the image
   * files among the sources are the originals, for attaching to the item.
   */
  onEnriched: (result: EnrichmentResult, sources: EnrichmentSources) => void
}

interface UseDropEnrichmentResult {
  isDragging: boolean
  /** What is being read right now, or null when idle. */
  enriching: EnrichmentKind | null
  dropHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
    onPaste: (e: React.ClipboardEvent) => void
  }
}

/**
 * Drag-and-drop (or paste) a web link or images onto a create form to
 * auto-fill it. The drop calls the server enrichment endpoint and hands the
 * result back via `onEnriched`. Images are downscaled in the browser before
 * they are sent; the originals travel with the result so the form can attach
 * them once the item exists.
 */
export function useDropEnrichment({
  itemType,
  enabled,
  onEnriched,
}: UseDropEnrichmentOptions): UseDropEnrichmentResult {
  const { handleError, showWarning } = useErrorHandler()
  const [isDragging, setIsDragging] = useState(false)
  const [enriching, setEnriching] = useState<EnrichmentKind | null>(null)
  // Depth counter so entering/leaving child elements doesn't flicker the overlay.
  const dragDepth = useRef(0)
  // Synchronous guard: a second drop while one is in flight is refused
  // before any state update lands.
  const inFlight = useRef(false)

  const enrich = useCallback(
    async (sources: EnrichmentSources, gesture: 'drop' | 'paste') => {
      if (inFlight.current) {
        showWarning(
          'Still reading the last one',
          'Wait for it to finish, then drop again.',
        )
        return
      }

      let images = sources.images
      if (images.length > MAX_ENRICHMENT_IMAGES) {
        showWarning(
          `Reading the first ${MAX_ENRICHMENT_IMAGES} images`,
          `Up to ${MAX_ENRICHMENT_IMAGES} images can be read at a time.`,
        )
        images = images.slice(0, MAX_ENRICHMENT_IMAGES)
      }
      if (sources.skippedFiles > 0) {
        showWarning(
          'Only images can be read',
          'Drop a photo, screenshot, or spec-sheet image to auto-fill the form.',
        )
      }
      if (images.length === 0 && !sources.url) {
        // A drop of plain text is a miss worth saying so about; a paste of
        // plain text outside a field is most likely nothing to do with us.
        if (gesture === 'drop' && sources.text) {
          showWarning(
            'Not a valid link',
            'Drop a web link (http or https) or an image to auto-fill the form.',
          )
        }
        return
      }

      inFlight.current = true
      setEnriching(images.length > 0 ? 'image' : 'link')
      try {
        const prepared: Array<EnrichmentImage> = []
        const readable: Array<File> = []
        for (const file of images) {
          try {
            prepared.push(await prepareImageForAi(file))
            readable.push(file)
          } catch {
            showWarning(`Couldn’t read ${file.name}`, 'Try a PNG or JPEG.')
          }
        }
        if (prepared.length === 0 && !sources.url) return

        const response = await apiPost<{ data: EnrichmentResult }>(
          '/api/v1/items/enrich',
          {
            itemType,
            ...(sources.url ? { url: sources.url } : {}),
            ...(prepared.length > 0 ? { images: prepared } : {}),
          },
        )
        onEnriched(response.data, { ...sources, images: readable })
      } catch (error) {
        handleError(error, {
          title: `Could not read the ${images.length > 0 ? 'image' : 'link'}`,
        })
      } finally {
        inFlight.current = false
        setEnriching(null)
      }
    },
    [itemType, onEnriched, handleError, showWarning],
  )

  const onDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !transferHasSources(e.dataTransfer)) return
      e.preventDefault()
      dragDepth.current += 1
      setIsDragging(true)
    },
    [enabled],
  )

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !transferHasSources(e.dataTransfer)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    [enabled],
  )

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !transferHasSources(e.dataTransfer)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setIsDragging(false)
    },
    [enabled],
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!enabled || !transferHasSources(e.dataTransfer)) return
      e.preventDefault()
      dragDepth.current = 0
      setIsDragging(false)
      void enrich(readTransferSources(e.dataTransfer), 'drop')
    },
    [enabled, enrich],
  )

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!enabled) return
      const sources = readTransferSources(e.clipboardData)
      // A pasted link only counts outside text fields — inside one it is the
      // user typing, and the field gets it. A pasted image counts anywhere:
      // no field can take it.
      const inTextField =
        (e.target as HTMLElement | null)?.closest(
          'input, textarea, [contenteditable="true"]',
        ) != null
      if (sources.images.length === 0 && (inTextField || !sources.url)) return
      e.preventDefault()
      void enrich(sources, 'paste')
    },
    [enabled, enrich],
  )

  return {
    isDragging,
    enriching,
    dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop, onPaste },
  }
}
