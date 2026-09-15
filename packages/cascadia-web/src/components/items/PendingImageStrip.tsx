// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { Image as ImageIcon, X } from 'lucide-react'
import { Badge, Button } from '@/components/ui'

interface PendingImageStripProps {
  files: Array<File>
  onRemove: (index: number) => void
}

/**
 * The images dropped onto a create form, waiting for the item to exist so
 * they can be attached to it. Rendered in create mode only; the first one
 * becomes the item's thumbnail.
 */
export function PendingImageStrip({ files, onRemove }: PendingImageStripProps) {
  const previews = useObjectUrls(files)
  if (files.length === 0) return null

  return (
    <div
      data-testid="pending-images"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50"
    >
      <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <ImageIcon className="h-4 w-4" />
        <span>
          Attached when you save — the first image becomes the thumbnail.
        </span>
      </div>
      <ul className="flex flex-wrap gap-2">
        {files.map((file, index) => (
          <li
            key={`${index}-${file.name}-${file.size}`}
            className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 dark:border-slate-700 dark:bg-slate-900"
          >
            {previews[index] && (
              <img
                src={previews[index]}
                alt=""
                className="h-8 w-8 rounded object-cover"
              />
            )}
            <span className="max-w-48 truncate text-xs text-slate-700 dark:text-slate-200">
              {file.name}
            </span>
            {index === 0 && (
              <Badge variant="outline" className="text-[10px]">
                Thumbnail
              </Badge>
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={`Remove ${file.name}`}
              onClick={() => onRemove(index)}
            >
              <X className="h-3 w-3" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Object URLs for a list of files, revoked when the list changes or unmounts. */
function useObjectUrls(files: Array<File>): Array<string> {
  const [urls, setUrls] = useState<Array<string>>([])
  useEffect(() => {
    const next = files.map((file) => URL.createObjectURL(file))
    setUrls(next)
    return () => {
      for (const url of next) URL.revokeObjectURL(url)
    }
  }, [files])
  return urls
}
