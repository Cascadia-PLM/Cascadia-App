import { useState } from 'react'
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
}

export function PartThumbnail({
  itemId,
  size = 'md',
  className,
}: PartThumbnailProps) {
  const [hasError, setHasError] = useState(false)
  const px = sizeMap[size]

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

  return (
    <img
      src={`/api/v1/items/${itemId}/thumbnail`}
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
