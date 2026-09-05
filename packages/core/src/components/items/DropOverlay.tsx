// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Image as ImageIcon, Link2, Loader2 } from 'lucide-react'
import type { EnrichmentKind } from './useDropEnrichment'

interface DropOverlayProps {
  isDragging: boolean
  /** What is being read, or null when nothing is. */
  enriching: EnrichmentKind | null
}

/**
 * Full-surface overlay shown while a link or image is being dragged over a
 * create form, or while the dropped source is being read. Rendered inside a
 * `relative` wrapper; `pointer-events-none` so it never swallows the drop.
 */
export function DropOverlay({ isDragging, enriching }: DropOverlayProps) {
  if (!isDragging && !enriching) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-blue-400 bg-white/95 px-8 py-6 text-center shadow-lg dark:bg-slate-800/95">
        {enriching ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {enriching === 'image'
                ? 'Reading the image and filling in details…'
                : 'Reading the link and filling in details…'}
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-3 text-blue-500">
              <Link2 className="h-8 w-8" />
              <ImageIcon className="h-8 w-8" />
            </div>
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Drop a link or image to auto-fill this form
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              A product page, photo, nameplate, or spec sheet — we’ll fill the
              empty fields from it
            </p>
          </>
        )}
      </div>
    </div>
  )
}
