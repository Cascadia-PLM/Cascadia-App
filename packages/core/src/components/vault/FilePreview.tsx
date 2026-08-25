// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Suspense, lazy, useEffect, useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import type { PreviewKind } from '@/lib/vault/preview'
import type { PdfMarkupBinding } from '@/components/vault/PdfViewer'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'
import { previewKindFor } from '@/lib/vault/preview'
import { SvgViewer } from '@/components/vault/SvgViewer'

// pdf.js and its worker are around a megabyte; most sessions never open a PDF,
// so the viewer is split out and fetched on first use.
const PdfViewer = lazy(() =>
  import('@/components/vault/PdfViewer').then((m) => ({
    default: m.PdfViewer,
  })),
)

export interface PreviewableFile {
  id: string
  originalFileName: string
  fileSize: number
}

interface FilePreviewProps {
  file: PreviewableFile
  /** Markup binding for PDFs. Omitted where markup does not apply. */
  markup?: PdfMarkupBinding
  className?: string
}

interface LoadedContent {
  kind: PreviewKind
  /** Object URL for pdf/image; `null` for the formats read as text. */
  objectUrl: string | null
  /** Decoded source for text and svg. */
  text: string | null
}

/**
 * Formats read as a string rather than as bytes.
 *
 * SVG is here for a reason beyond convenience: an object URL for SVG markup
 * carries this app's origin, so handing one to an `<img>` leaves a live
 * same-origin document one "open in new tab" away. `SvgViewer` re-labels the
 * source itself; see the note on `toDataUrl` there.
 */
const TEXTUAL_KINDS: ReadonlySet<PreviewKind> = new Set(['text', 'svg'])

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-64 items-center justify-center p-8 text-center">
      {children}
    </div>
  )
}

/**
 * Renders an attached file in place, for the formats Cascadia can display.
 *
 * The bytes are fetched with `fetch` and handed to the viewer as an object
 * URL rather than pointed at with an `<iframe>`: every API response carries
 * `X-Frame-Options: DENY`, and the vault's content endpoint is session-cookie
 * authenticated, so a same-origin fetch is both the only thing that works and
 * the thing that keeps the credential out of the URL.
 */
export function FilePreview({ file, markup, className }: FilePreviewProps) {
  const [content, setContent] = useState<LoadedContent | null>(null)
  const [error, setError] = useState<string | null>(null)

  const kind = previewKindFor(file.originalFileName)

  useEffect(() => {
    if (kind === null) return

    let objectUrl: string | null = null
    let cancelled = false

    const load = async () => {
      setContent(null)
      setError(null)

      try {
        const response = await fetch(`/api/v1/files/${file.id}/content`)

        if (!response.ok) {
          // `{ error: { code, message, details } }` — the envelope every API
          // error uses. Reading `error` as a string instead put a literal
          // "[object Object]" under "Preview unavailable". `details` is
          // deliberately not shown: on a storage miss it is the vault path.
          const body = (await response.json().catch(() => null)) as {
            error?: { code?: string; message?: string }
          } | null
          throw new Error(
            body?.error?.message ?? `Preview failed (${response.status})`,
          )
        }

        if (TEXTUAL_KINDS.has(kind)) {
          const text = await response.text()
          if (cancelled) return
          setContent({ kind, objectUrl: null, text })
          return
        }

        const blob = await response.blob()
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setContent({ kind, objectUrl, text: null })
      } catch (err) {
        if (!cancelled) setError((err as Error).message)
      }
    }

    void load()

    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [file.id, kind])

  const downloadButton = (
    <Button variant="ghost" size="icon" asChild title="Download">
      <a href={`/api/v1/files/${file.id}/download`} download>
        <Download className="h-4 w-4" />
      </a>
    </Button>
  )

  if (kind === null) {
    return (
      <Centered>
        <p className="text-slate-600 dark:text-slate-400">
          {file.originalFileName} cannot be previewed. Download it to open it in
          another application.
        </p>
      </Centered>
    )
  }

  if (error !== null) {
    return (
      <Centered>
        <div className="space-y-1">
          <p className="text-red-600 dark:text-red-400">Preview unavailable</p>
          <p className="text-sm text-slate-600 dark:text-slate-400">{error}</p>
        </div>
      </Centered>
    )
  }

  if (!content) {
    return (
      <Centered>
        <span className="flex items-center gap-2 text-slate-600 dark:text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading {file.originalFileName}...
        </span>
      </Centered>
    )
  }

  if (content.kind === 'pdf' && content.objectUrl !== null) {
    return (
      <Suspense
        fallback={
          <Centered>
            <Loader2 className="h-4 w-4 animate-spin text-slate-600 dark:text-slate-400" />
          </Centered>
        }
      >
        <PdfViewer
          fileUrl={content.objectUrl}
          fileName={file.originalFileName}
          toolbarExtra={downloadButton}
          markup={markup}
          className={className}
        />
      </Suspense>
    )
  }

  if (content.kind === 'svg' && content.text !== null) {
    return (
      <SvgViewer
        source={content.text}
        fileName={file.originalFileName}
        toolbarExtra={downloadButton}
        className={className}
      />
    )
  }

  if (content.kind === 'image' && content.objectUrl !== null) {
    return (
      <div
        className={cn(
          'flex items-center justify-center overflow-auto rounded-lg border border-slate-200 bg-slate-100 p-4 dark:border-slate-700 dark:bg-slate-900',
          className,
        )}
      >
        <img
          src={content.objectUrl}
          alt={file.originalFileName}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }

  return (
    <pre
      className={cn(
        'overflow-auto rounded-lg border border-slate-200 bg-white p-4 font-mono text-xs whitespace-pre-wrap text-slate-800 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200',
        className,
      )}
    >
      {content.text}
    </pre>
  )
}
