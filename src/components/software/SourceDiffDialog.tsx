import { useEffect, useRef, useState } from 'react'
import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { languageFor } from './language'
import type { Extension } from '@codemirror/state'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

interface BlobResponse {
  blob: {
    hash: string
    size: number
    isBinary: boolean
    content: string
    encoding: 'utf8' | 'base64'
  }
}

export interface SourceDiffTarget {
  /** Software item id used to authorize blob reads */
  itemId: string
  path: string
  /** Missing hash = empty side (file added or deleted) */
  oldHash?: string | null
  newHash?: string | null
  oldLabel?: string
  newLabel?: string
}

async function fetchBlobText(
  itemId: string,
  hash: string | null | undefined,
): Promise<{ text: string; binary: boolean }> {
  if (!hash) return { text: '', binary: false }
  const result = await apiFetch<{ data: BlobResponse }>(
    `/api/v1/software/${itemId}/blob/${hash}`,
  )
  const blob = result.data.blob
  return { text: blob.isBinary ? '' : blob.content, binary: blob.isBinary }
}

function SideBySideDiff({
  path,
  oldText,
  newText,
}: {
  path: string
  oldText: string
  newText: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const isDark = document.documentElement.classList.contains('dark')
    const shared: Array<Extension> = [
      basicSetup,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({
        '&': { fontSize: '13px' },
        '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
      }),
    ]
    const lang = languageFor(path)
    if (lang) shared.push(lang)
    if (isDark) shared.push(oneDark)

    const view = new MergeView({
      a: { doc: oldText, extensions: shared },
      b: { doc: newText, extensions: shared },
      parent: containerRef.current,
      collapseUnchanged: { margin: 3, minSize: 4 },
    })

    return () => view.destroy()
  }, [path, oldText, newText])

  return <div ref={containerRef} className="max-h-[65vh] overflow-auto" />
}

/**
 * Side-by-side line diff of one source file between two versions.
 * Content is fetched by blob hash, so it works for any historical version -
 * including paths that no longer exist in a current tree.
 */
export function SourceDiffDialog({
  target,
  onClose,
}: {
  target: SourceDiffTarget | null
  onClose: () => void
}) {
  const { handleError } = useErrorHandler()
  const [contents, setContents] = useState<{
    oldText: string
    newText: string
    binary: boolean
  } | null>(null)

  useEffect(() => {
    if (!target) {
      setContents(null)
      return
    }
    let cancelled = false
    Promise.all([
      fetchBlobText(target.itemId, target.oldHash),
      fetchBlobText(target.itemId, target.newHash),
    ])
      .then(([oldBlob, newBlob]) => {
        if (cancelled) return
        setContents({
          oldText: oldBlob.text,
          newText: newBlob.text,
          binary: oldBlob.binary || newBlob.binary,
        })
      })
      .catch((error) => {
        if (!cancelled) {
          handleError(error, { title: 'Failed to load diff' })
          onClose()
        }
      })
    return () => {
      cancelled = true
    }
  }, [target, handleError, onClose])

  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-base">
            {target?.path}
          </DialogTitle>
          <DialogDescription>
            {target?.oldLabel ?? 'Before'} → {target?.newLabel ?? 'After'}
          </DialogDescription>
        </DialogHeader>
        {!contents ? (
          <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
            Loading diff...
          </div>
        ) : contents.binary ? (
          <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
            Binary file - line diff not available
          </div>
        ) : (
          <SideBySideDiff
            path={target?.path ?? ''}
            oldText={contents.oldText}
            newText={contents.newText}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
