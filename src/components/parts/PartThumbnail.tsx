import { useEffect, useState } from 'react'
import { Box } from 'lucide-react'
import { cn } from '@/lib/utils'

const sizeMap = {
  sm: 32,
  md: 48,
  lg: 64,
} as const

interface PartThumbnailProps {
  itemId: string
  size?: keyof typeof sizeMap
  className?: string
  /**
   * Bump to force a re-fetch after the item's thumbnail changes. Without it the
   * browser keeps showing the cached image for the unchanged URL.
   */
  version?: number | string
}

export function PartThumbnail({
  itemId,
  size = 'md',
  className,
  version,
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

  return (
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
}
