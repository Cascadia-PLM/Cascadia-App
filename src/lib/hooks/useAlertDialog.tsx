import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/AlertDialog'

interface AlertOptions {
  title: string
  description: string
  actionLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'destructive'
}

interface ConfirmOptions extends AlertOptions {
  onConfirm: () => void | Promise<void>
}

interface AlertDialogContextValue {
  alert: (options: AlertOptions) => void
  confirm: (options: ConfirmOptions) => void
}

const AlertDialogContext = createContext<AlertDialogContextValue | null>(null)

interface AlertDialogState {
  open: boolean
  title: string
  description: string
  actionLabel: string
  cancelLabel?: string
  variant: 'default' | 'destructive'
  onConfirm?: () => void | Promise<void>
}

export function AlertDialogProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AlertDialogState>({
    open: false,
    title: '',
    description: '',
    actionLabel: 'OK',
    variant: 'default',
  })

  const alert = (options: AlertOptions) => {
    setState({
      open: true,
      title: options.title,
      description: options.description,
      actionLabel: options.actionLabel || 'OK',
      variant: options.variant || 'default',
    })
  }

  const confirm = (options: ConfirmOptions) => {
    setState({
      open: true,
      title: options.title,
      description: options.description,
      actionLabel: options.actionLabel || 'Confirm',
      cancelLabel: options.cancelLabel || 'Cancel',
      variant: options.variant || 'default',
      onConfirm: options.onConfirm,
    })
  }

  const handleAction = async () => {
    if (state.onConfirm) {
      await state.onConfirm()
    }
    setState((prev) => ({ ...prev, open: false }))
  }

  const handleCancel = () => {
    setState((prev) => ({ ...prev, open: false }))
  }

  return (
    <AlertDialogContext.Provider value={{ alert, confirm }}>
      {children}
      <AlertDialog
        open={state.open}
        onOpenChange={(open) => setState((prev) => ({ ...prev, open }))}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{state.title}</AlertDialogTitle>
            <AlertDialogDescription>{state.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            {state.cancelLabel && (
              <AlertDialogCancel onClick={handleCancel}>
                {state.cancelLabel}
              </AlertDialogCancel>
            )}
            <AlertDialogAction
              onClick={handleAction}
              className={
                state.variant === 'destructive'
                  ? 'bg-red-600 hover:bg-red-700 focus:ring-red-600 dark:bg-red-500 dark:hover:bg-red-600 dark:focus:ring-red-500'
                  : undefined
              }
            >
              {state.actionLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AlertDialogContext.Provider>
  )
}

export function useAlertDialog() {
  const context = useContext(AlertDialogContext)
  if (!context) {
    throw new Error('useAlertDialog must be used within AlertDialogProvider')
  }
  return context
}
