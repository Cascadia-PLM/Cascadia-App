// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  Download,
  Image as ImageIcon,
} from 'lucide-react'
import type { KeyboardEvent } from 'react'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { itemFilesQuery } from '@/lib/query/options/item-files'
import { isDisplayableImage } from '@/lib/vault/image-files'

/** The subset of a vault file record the gallery needs. */
export interface GalleryImage {
  id: string
  originalFileName: string
  mimeType: string
  fileSize: number
  uploadedAt: string
  isItemThumbnail?: boolean
}

/** Version context an item's files are resolved in. */
export interface ImageGalleryContext {
  branchId?: string
  mainBranchId?: string
}

/**
 * The images attached to an item, in the current version context.
 *
 * Reads the same query as `FileList`, so a detail page can ask "are there
 * images?" (to decide whether to offer a Gallery tab) without a second fetch.
 */
export function useItemImages(
  itemId: string | undefined,
  context: ImageGalleryContext,
) {
  const { data: files = [], isLoading } = useQuery({
    ...itemFilesQuery<GalleryImage>(itemId ?? '', context),
    enabled: Boolean(itemId),
  })

  const images = files.filter((file) =>
    isDisplayableImage(file.originalFileName, file.mimeType),
  )

  return { images, isLoading }
}

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${Math.round((bytes / Math.pow(k, i)) * 100) / 100} ${sizes[i]}`
}

/** Vault files are served from one endpoint; `<img>` ignores its attachment disposition. */
const imageUrl = (fileId: string) => `/api/v1/files/${fileId}/download`

/**
 * Save an image to disk. The endpoint already answers with an attachment
 * disposition, so a same-origin link is enough — no blob round-trip, and no
 * blank tab left behind by `window.open`.
 */
const download = (image: GalleryImage) => {
  const link = document.createElement('a')
  link.href = imageUrl(image.id)
  link.download = image.originalFileName
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}

interface ImageGalleryProps {
  itemId: string
  branchId?: string
  mainBranchId?: string
  className?: string
}

/**
 * Browsable grid of the images attached to an item, with a full-size lightbox.
 *
 * There is no per-file resized-thumbnail endpoint, so tiles load the original
 * image lazily and let the browser scale it.
 */
export function ImageGallery({
  itemId,
  branchId,
  mainBranchId,
  className,
}: ImageGalleryProps) {
  const { images, isLoading } = useItemImages(itemId, {
    branchId,
    mainBranchId,
  })
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // Deleting or filtering images can shrink the list out from under the
  // lightbox; close it rather than pointing past the end.
  useEffect(() => {
    if (openIndex !== null && openIndex >= images.length) {
      setOpenIndex(null)
    }
  }, [images.length, openIndex])

  const showPrevious = useCallback(() => {
    setOpenIndex((current) =>
      current === null ? null : (current - 1 + images.length) % images.length,
    )
  }, [images.length])

  const showNext = useCallback(() => {
    setOpenIndex((current) =>
      current === null ? null : (current + 1) % images.length,
    )
  }, [images.length])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      showPrevious()
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      showNext()
    }
  }

  if (isLoading) {
    return (
      <div className={cn('text-center py-12', className)}>
        <p className="text-slate-600 dark:text-slate-400">Loading images...</p>
      </div>
    )
  }

  if (images.length === 0) {
    return (
      <div className={cn('text-center py-12', className)}>
        <ImageIcon className="w-16 h-16 mx-auto mb-4 text-slate-300 dark:text-slate-600" />
        <p className="text-slate-600 dark:text-slate-400">
          No images attached to this item
        </p>
        <p className="text-sm text-slate-500 dark:text-slate-500 mt-1">
          Upload an image on the Details tab to start a gallery
        </p>
      </div>
    )
  }

  const openImage = openIndex === null ? null : (images[openIndex] ?? null)

  return (
    <div className={className} data-testid="image-gallery">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {images.map((image, index) => (
          <button
            key={image.id}
            type="button"
            onClick={() => setOpenIndex(index)}
            title={image.originalFileName}
            className="group text-left rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-950 hover:border-cyan-500 dark:hover:border-cyan-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-600 dark:focus-visible:ring-cyan-300"
          >
            <div className="aspect-square bg-slate-100 dark:bg-slate-900">
              <img
                src={imageUrl(image.id)}
                alt={image.originalFileName}
                loading="lazy"
                className="w-full h-full object-contain transition-transform group-hover:scale-[1.02]"
              />
            </div>
            <div className="p-2 space-y-1">
              <p className="text-sm font-medium truncate text-slate-900 dark:text-white">
                {image.originalFileName}
              </p>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 dark:text-slate-400">
                  {formatFileSize(image.fileSize)}
                </span>
                {image.isItemThumbnail && (
                  <Badge variant="secondary" className="text-xs">
                    Thumbnail
                  </Badge>
                )}
              </div>
            </div>
          </button>
        ))}
      </div>

      <Dialog
        open={openImage !== null}
        onOpenChange={(open) => {
          if (!open) setOpenIndex(null)
        }}
      >
        {openImage && (
          <DialogContent
            className="max-w-5xl max-h-[92vh] overflow-y-auto"
            onKeyDown={handleKeyDown}
            data-testid="image-gallery-lightbox"
          >
            <div className="pr-8">
              <DialogTitle className="truncate">
                {openImage.originalFileName}
              </DialogTitle>
              <DialogDescription>
                {formatFileSize(openImage.fileSize)} • uploaded{' '}
                {new Date(openImage.uploadedAt).toLocaleDateString()}
                {images.length > 1 &&
                  ` • ${(openIndex ?? 0) + 1} of ${images.length}`}
              </DialogDescription>
            </div>

            <div className="relative flex items-center justify-center bg-slate-100 dark:bg-slate-900 rounded-md">
              <img
                src={imageUrl(openImage.id)}
                alt={openImage.originalFileName}
                className="max-h-[65vh] w-auto max-w-full object-contain"
              />
              {images.length > 1 && (
                <>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={showPrevious}
                    title="Previous image"
                    aria-label="Previous image"
                    className="absolute left-2 top-1/2 -translate-y-1/2"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={showNext}
                    title="Next image"
                    aria-label="Next image"
                    className="absolute right-2 top-1/2 -translate-y-1/2"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>

            <div className="flex justify-end">
              <Button variant="outline" onClick={() => download(openImage)}>
                <Download className="h-4 w-4 mr-2" />
                Download
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  )
}
