import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react'
import type { ToastVariant } from '@/lib/hooks/useToast'
import { useToast } from '@/lib/hooks/useToast'
import { cn } from '@/lib/utils'

const variantStyles: Record<ToastVariant, string> = {
  default: 'bg-white border-gray-300 dark:bg-gray-800 dark:border-gray-700',
  success:
    'bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800',
  warning:
    'bg-yellow-50 border-yellow-200 dark:bg-yellow-950 dark:border-yellow-800',
  destructive: 'bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800',
}

const variantIcons: Record<ToastVariant, React.ReactNode> = {
  default: <Info className="h-5 w-5 text-gray-500 dark:text-gray-400" />,
  success: (
    <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
  ),
  warning: (
    <AlertTriangle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
  ),
  destructive: <XCircle className="h-5 w-5 text-red-600 dark:text-red-400" />,
}

/**
 * Container component that renders all active toast notifications.
 * Should be placed in your root layout.
 */
export function ToastContainer() {
  const { toasts, removeToast } = useToast()

  if (toasts.length === 0) {
    return null
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={cn(
            'p-4 rounded-lg shadow-lg border pointer-events-auto',
            'animate-in slide-in-from-right-full duration-300',
            variantStyles[toast.variant],
          )}
          role="alert"
          aria-live="polite"
        >
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              {variantIcons[toast.variant]}
            </div>
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm text-gray-900 dark:text-white">
                {toast.title}
              </p>
              {toast.description && (
                <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
                  {toast.description}
                </p>
              )}
              {toast.action && (
                <button
                  type="button"
                  onClick={toast.action.onClick}
                  className="text-sm font-medium text-cyan-600 dark:text-cyan-400 mt-2 hover:underline focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2 rounded"
                >
                  {toast.action.label}
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="flex-shrink-0 text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white focus:outline-none focus:ring-2 focus:ring-cyan-600 focus:ring-offset-2 rounded"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
