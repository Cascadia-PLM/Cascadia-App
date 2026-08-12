// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  AnnotationGeometry,
  FileAnnotation,
} from '@/lib/vault/annotations'
import type { AnnotationTool } from '@/components/vault/PdfAnnotationLayer'
import type { PdfMarkupBinding } from '@/components/vault/PdfViewer'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Textarea,
} from '@/components/ui'
import { DEFAULT_ANNOTATION_COLOR } from '@/lib/vault/annotations'
import { fileAnnotationsQuery } from '@/lib/query/options/file-annotations'
import { useInvalidateResources } from '@/lib/query'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'

interface UseFileMarkupOptions {
  fileId: string
  /**
   * Whether the owning item is checked out to this user. A hint for the
   * toolbar only — the server re-checks on every write and this hook surfaces
   * whatever it says, so a stale hint fails loudly rather than silently.
   */
  canAnnotate: boolean
  /** Explains the missing toolbar, e.g. 'Check out this item to mark it up'. */
  disabledReason?: string | null
  currentUserId?: string
}

interface PendingText {
  title: string
  description: string
  value: string
  /** Called with the final text, or not at all if the author cancels. */
  commit: (contents: string) => void
}

/**
 * Markup state for one file, packaged as the binding `PdfViewer` expects.
 *
 * Returns the dialog alongside the binding because two of the five kinds —
 * comments and text labels — are meaningless without their words, so they
 * prompt at creation rather than dropping an empty pin the author has to
 * remember to fill in later. Render `markupDialog` anywhere in the subtree.
 */
export function useFileMarkup({
  fileId,
  canAnnotate,
  disabledReason,
  currentUserId,
}: UseFileMarkupOptions): {
  markup: PdfMarkupBinding
  markupDialog: React.ReactNode
} {
  const { alert } = useAlertDialog()
  const invalidate = useInvalidateResources()

  const [tool, setTool] = useState<AnnotationTool>('select')
  const [color, setColor] = useState<string>(DEFAULT_ANNOTATION_COLOR)
  const [pending, setPending] = useState<PendingText | null>(null)
  const draftRef = useRef('')

  const { data: annotations = [] } = useQuery(fileAnnotationsQuery(fileId))

  const reportFailure = useCallback(
    (action: string, error: unknown) => {
      alert({
        title: `Could not ${action} markup`,
        description:
          error instanceof Error ? error.message : `Failed to ${action} markup`,
        variant: 'destructive',
      })
    },
    [alert],
  )

  const save = useCallback(
    async (
      pageNumber: number,
      geometry: AnnotationGeometry,
      contents: string | null,
    ) => {
      try {
        await apiFetch(`/api/v1/files/${fileId}/annotations`, {
          method: 'POST',
          body: JSON.stringify({ pageNumber, geometry, color, contents }),
        })
        await invalidate('files')
      } catch (error) {
        reportFailure('add', error)
      }
    },
    [color, fileId, invalidate, reportFailure],
  )

  const onCreate = useCallback(
    (pageNumber: number, geometry: AnnotationGeometry) => {
      if (geometry.kind === 'note' || geometry.kind === 'text') {
        draftRef.current = ''
        setPending({
          title:
            geometry.kind === 'note' ? 'Add a comment' : 'Add a text label',
          description:
            geometry.kind === 'note'
              ? 'Pinned to the point you clicked.'
              : 'Drawn onto the page at the point you clicked.',
          value: '',
          commit: (contents) => void save(pageNumber, geometry, contents),
        })
        return
      }
      void save(pageNumber, geometry, null)
    },
    [save],
  )

  const onSelect = useCallback(
    (annotation: FileAnnotation) => {
      // Only the author can revise their own words — an annotation is an
      // attributed statement, and letting someone else rewrite it under that
      // name would make the attribution a lie. Everyone else gets the tooltip.
      if (!canAnnotate || annotation.authorId !== currentUserId) return
      if (annotation.kind !== 'note' && annotation.kind !== 'text') return

      draftRef.current = annotation.contents ?? ''
      setPending({
        title: 'Edit markup',
        description: 'Clear the text and save to leave it blank.',
        value: annotation.contents ?? '',
        commit: (contents) => {
          if (contents === annotation.contents) return
          void (async () => {
            try {
              await apiFetch(
                `/api/v1/files/${fileId}/annotations/${annotation.id}`,
                { method: 'PATCH', body: JSON.stringify({ contents }) },
              )
              await invalidate('files')
            } catch (error) {
              reportFailure('update', error)
            }
          })()
        },
      })
    },
    [canAnnotate, currentUserId, fileId, invalidate, reportFailure],
  )

  const onDelete = useCallback(
    (annotation: FileAnnotation) => {
      void (async () => {
        try {
          await apiFetch(
            `/api/v1/files/${fileId}/annotations/${annotation.id}`,
            { method: 'DELETE' },
          )
          await invalidate('files')
        } catch (error) {
          reportFailure('delete', error)
        }
      })()
    },
    [fileId, invalidate, reportFailure],
  )

  // Anyone holding the checkout may remove markup that no longer applies; the
  // affordance only appears where it could actually be acted on.
  const deletableIds = new Set(
    canAnnotate ? annotations.map((annotation) => annotation.id) : [],
  )

  const markupDialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{pending?.title ?? 'Markup'}</DialogTitle>
          <DialogDescription>{pending?.description}</DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          rows={4}
          defaultValue={pending?.value ?? ''}
          onChange={(event) => {
            draftRef.current = event.target.value
          }}
          placeholder="Type here"
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setPending(null)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              const text = draftRef.current.trim()
              // Cancelling out of an empty prompt cancels the markup itself —
              // a blank pin is noise on the drawing.
              if (text) pending?.commit(text)
              setPending(null)
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return {
    markup: {
      annotations,
      canAnnotate,
      tool,
      color,
      deletableIds,
      onCreate,
      onSelect,
      onDelete,
      onToolChange: setTool,
      onColorChange: setColor,
      disabledReason: disabledReason ?? null,
    },
    markupDialog,
  }
}
