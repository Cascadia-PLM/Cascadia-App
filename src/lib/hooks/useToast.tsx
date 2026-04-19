import { createContext, useCallback, useContext, useState } from 'react'
import type { ReactNode } from 'react'

/**
 * Toast notification variants.
 */
export type ToastVariant = 'default' | 'success' | 'warning' | 'destructive'

/**
 * A toast notification.
 */
export interface Toast {
  id: string
  title: string
  description?: string
  variant: ToastVariant
  duration?: number
  action?: {
    label: string
    onClick: () => void
  }
}

interface ToastContextValue {
  toasts: Array<Toast>
  addToast: (toast: Omit<Toast, 'id'>) => string
  removeToast: (id: string) => void
  clearToasts: () => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

/**
 * Provider component for toast notifications.
 * Should be placed near the root of your application.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Array<Toast>>([])

  const addToast = useCallback((toast: Omit<Toast, 'id'>): string => {
    const id = Math.random().toString(36).slice(2)
    const newToast = { ...toast, id }

    setToasts((prev) => [...prev, newToast])

    // Auto-dismiss after duration (default 5s, 0 = never dismiss)
    const duration = toast.duration ?? 5000
    if (duration > 0) {
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id))
      }, duration)
    }

    return id
  }, [])

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const clearToasts = useCallback(() => {
    setToasts([])
  }, [])

  return (
    <ToastContext.Provider
      value={{ toasts, addToast, removeToast, clearToasts }}
    >
      {children}
    </ToastContext.Provider>
  )
}

/**
 * Hook to access toast notification functions.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { addToast } = useToast()
 *
 *   const handleClick = () => {
 *     addToast({
 *       title: 'Success',
 *       description: 'Your changes have been saved.',
 *       variant: 'success',
 *     })
 *   }
 *
 *   return <button onClick={handleClick}>Save</button>
 * }
 * ```
 */
export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within ToastProvider')
  }
  return context
}

/**
 * Convenience function to create a success toast.
 */
export function createSuccessToast(
  title: string,
  description?: string,
): Omit<Toast, 'id'> {
  return { title, description, variant: 'success' }
}

/**
 * Convenience function to create a warning toast.
 */
export function createWarningToast(
  title: string,
  description?: string,
): Omit<Toast, 'id'> {
  return { title, description, variant: 'warning' }
}

/**
 * Convenience function to create an error toast.
 */
export function createErrorToast(
  title: string,
  description?: string,
): Omit<Toast, 'id'> {
  return { title, description, variant: 'destructive' }
}
