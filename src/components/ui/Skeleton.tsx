import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  /** The visual style of the skeleton */
  variant?: 'text' | 'circular' | 'rectangular'
  /** Width of the skeleton (CSS value or number in pixels) */
  width?: string | number
  /** Height of the skeleton (CSS value or number in pixels) */
  height?: string | number
}

/**
 * Skeleton component for loading placeholders.
 * Displays a pulsing animation to indicate content is loading.
 */
const Skeleton = forwardRef<HTMLDivElement, SkeletonProps>(
  ({ className, variant = 'rectangular', width, height, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          'animate-pulse bg-slate-200 dark:bg-slate-700',
          variant === 'circular' && 'rounded-full',
          variant === 'text' && 'rounded h-4',
          variant === 'rectangular' && 'rounded',
          className,
        )}
        style={{ width, height }}
        aria-hidden="true"
        {...props}
      />
    )
  },
)

Skeleton.displayName = 'Skeleton'
export { Skeleton }
