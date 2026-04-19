import { cn } from '@/lib/utils'

interface PageContainerProps {
  children: React.ReactNode
  /**
   * Maximum width variant for the content area.
   * - 'full': No max-width constraint, uses full available space (default for list pages)
   * - 'wide': max-w-7xl (1280px) - for detail pages with moderate content
   * - 'narrow': max-w-4xl (896px) - for forms and focused content
   */
  maxWidth?: 'full' | 'wide' | 'narrow'
  /** Additional CSS classes for the outer container */
  className?: string
  /** Optional test ID for E2E testing */
  'data-testid'?: string
}

const maxWidthClasses = {
  full: 'max-w-[1920px]',
  wide: 'max-w-7xl',
  narrow: 'max-w-4xl',
}

/**
 * PageContainer provides consistent page layout with dynamic width support.
 *
 * The container expands to fill available screen space up to a sensible maximum,
 * making better use of larger monitors while maintaining readability.
 */
export function PageContainer({
  children,
  maxWidth = 'full',
  className,
  'data-testid': testId,
}: PageContainerProps) {
  return (
    <div
      className={cn(
        'min-h-screen bg-slate-50 dark:bg-slate-900 p-8',
        className,
      )}
      data-testid={testId}
    >
      <div className={cn(maxWidthClasses[maxWidth], 'mx-auto space-y-6')}>
        {children}
      </div>
    </div>
  )
}
