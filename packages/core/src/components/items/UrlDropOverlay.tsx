// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link2, Loader2 } from 'lucide-react'

interface UrlDropOverlayProps {
  isDragging: boolean
  isEnriching: boolean
}

/**
 * Full-surface overlay shown while a link is being dragged over a create form
 * or while the dropped link is being parsed. Rendered inside a `relative`
 * wrapper; `pointer-events-none` so it never swallows the drop event.
 */
export function UrlDropOverlay({
  isDragging,
  isEnriching,
}: UrlDropOverlayProps) {
  if (!isDragging && !isEnriching) return null

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-blue-400 bg-white/95 px-8 py-6 text-center shadow-lg dark:bg-slate-800/95">
        {isEnriching ? (
          <>
            <Loader2 className="h-8 w-8 animate-spin text-blue-500" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Reading the link and filling in details…
            </p>
          </>
        ) : (
          <>
            <Link2 className="h-8 w-8 text-blue-500" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Drop a link to auto-fill this form
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              We’ll use it to populate empty fields
            </p>
          </>
        )}
      </div>
    </div>
  )
}
