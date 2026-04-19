import { forwardRef, useState } from 'react'
import type { HTMLAttributes, ImgHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  /** Image source URL */
  src?: string
  /** Alt text for the image */
  alt?: string
  /** Fallback text (typically user's name) to generate initials */
  fallback?: string
  /** Size variant */
  size?: 'sm' | 'default' | 'lg'
}

const sizes = {
  sm: 'h-6 w-6 text-xs',
  default: 'h-8 w-8 text-sm',
  lg: 'h-10 w-10 text-base',
}

/**
 * Avatar component for displaying user profile images.
 * Falls back to initials when no image is provided or if image fails to load.
 *
 * @example
 * ```tsx
 * // With image
 * <Avatar src="/user.jpg" alt="John Doe" fallback="John Doe" />
 *
 * // With initials only
 * <Avatar fallback="John Doe" />
 *
 * // Different sizes
 * <Avatar fallback="JD" size="sm" />
 * <Avatar fallback="JD" size="lg" />
 * ```
 */
const Avatar = forwardRef<HTMLDivElement, AvatarProps>(
  ({ className, src, alt, fallback, size = 'default', ...props }, ref) => {
    const [imageError, setImageError] = useState(false)

    const initials = fallback
      ?.split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2)

    const showImage = src && !imageError

    return (
      <div
        ref={ref}
        className={cn(
          'relative flex shrink-0 items-center justify-center overflow-hidden rounded-full',
          'bg-cyan-600 text-white font-medium',
          sizes[size],
          className,
        )}
        role="img"
        aria-label={alt || fallback || 'User avatar'}
        {...props}
      >
        {showImage ? (
          <img
            src={src}
            alt={alt || fallback || 'Avatar'}
            className="h-full w-full object-cover"
            onError={() => setImageError(true)}
          />
        ) : (
          <span aria-hidden="true">{initials}</span>
        )}
      </div>
    )
  },
)

Avatar.displayName = 'Avatar'
export { Avatar }
