import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface RetryPromptProps {
  /** Error message to display */
  message: string
  /** Called when the retry button is clicked */
  onRetry: () => void
  /** Whether a retry is currently in progress */
  retrying?: boolean
  /** Additional CSS classes */
  className?: string
}

/**
 * A component that displays an error message with a retry button.
 * Used when auto-retries are exhausted but the error is still retryable.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { error, canRetry, retry, retrying } = useRetryableFetch('/api/v1/data')
 *
 *   if (error && canRetry) {
 *     return <RetryPrompt message={error.message} onRetry={retry} retrying={retrying} />
 *   }
 * }
 * ```
 */
export function RetryPrompt({
  message,
  onRetry,
  retrying = false,
  className,
}: RetryPromptProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 p-4 rounded-lg',
        'bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800',
        className,
      )}
      role="alert"
    >
      <AlertCircle className="h-5 w-5 text-red-600 dark:text-red-400 flex-shrink-0" />
      <p className="text-sm text-red-600 dark:text-red-400 flex-1">{message}</p>
      <Button
        size="sm"
        variant="outline"
        onClick={onRetry}
        disabled={retrying}
        className="flex-shrink-0"
      >
        {retrying ? (
          <>
            <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            Retrying...
          </>
        ) : (
          <>
            <RefreshCw className="h-4 w-4 mr-2" />
            Retry
          </>
        )}
      </Button>
    </div>
  )
}

/**
 * A more compact inline version of RetryPrompt.
 */
export function RetryPromptInline({
  message,
  onRetry,
  retrying = false,
  className,
}: RetryPromptProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-2 text-sm text-red-600 dark:text-red-400',
        className,
      )}
      role="alert"
    >
      <AlertCircle className="h-4 w-4 flex-shrink-0" />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex items-center font-medium hover:underline focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 rounded disabled:opacity-50"
      >
        {retrying ? <RefreshCw className="h-3 w-3 animate-spin" /> : 'Retry'}
      </button>
    </div>
  )
}
