// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { Box } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/Tooltip'
import { cn } from '@/lib/utils'

const sizeMap = {
  sm: 32,
  md: 48,
  lg: 64,
} as const

/**
 * Edge length of the hover preview. The thumbnail endpoint serves 512px CAD
 * renders, so this stays under the source resolution and never upscales.
 */
const PREVIEW_PX = 288

interface PartThumbnailProps {
  itemId: string
  size?: keyof typeof sizeMap
  className?: string
  /**
   * Bump to force a re-fetch after the item's thumbnail changes. Without it the
   * browser keeps showing the cached image for the unchanged URL.
   */
  version?: number | string
  /**
   * Show a larger version on hover. Costs no extra network: the preview reuses
   * the same URL the inline image already fetched, so it resolves from cache.
   */
  preview?: boolean
}

export function PartThumbnail({
  itemId,
  size = 'md',
  className,
  version,
  preview = false,
}: PartThumbnailProps) {
  const [hasError, setHasError] = useState(false)
  const px = sizeMap[size]

  // A new version may well resolve to an image where the last one 404'd
  useEffect(() => {
    setHasError(false)
  }, [itemId, version])

  if (hasError) {
    return (
      <div
        className={cn(
          'flex items-center justify-center rounded bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500',
          className,
        )}
        style={{ width: px, height: px }}
      >
        <Box className="w-1/2 h-1/2" />
      </div>
    )
  }

  const src =
    version === undefined
      ? `/api/v1/items/${itemId}/thumbnail`
      : `/api/v1/items/${itemId}/thumbnail?v=${encodeURIComponent(String(version))}`

  const image = (
    <img
      src={src}
      alt=""
      loading="lazy"
      className={cn(
        'rounded bg-slate-100 dark:bg-slate-800 object-contain',
        className,
      )}
      style={{ width: px, height: px }}
      onError={() => setHasError(true)}
    />
  )

  if (!preview) {
    return image
  }

  return (
    <Tooltip>
      {/* A span, not the default button: one tab stop per grid row would bury
          the row's real actions. The preview is a pointer affordance only. */}
      <TooltipTrigger asChild>
        <span className="inline-flex">{image}</span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className="p-1 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-lg"
      >
        {/* Same src as above, so this is a cache hit rather than a second GET */}
        <img
          src={src}
          alt=""
          className="rounded object-contain"
          style={{ width: PREVIEW_PX, height: PREVIEW_PX }}
        />
      </TooltipContent>
    </Tooltip>
  )
}
