import { useState } from 'react'
import { Maximize2, Minimize2, X } from 'lucide-react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button } from './Button'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

interface FullscreenGraphWrapperProps {
  /** The graph content to render (both inline and fullscreen) */
  children: ReactNode
  /** Title shown in fullscreen header */
  title?: string
  /** Optional subtitle/description */
  subtitle?: string
  /** Height of the inline container (default: 600px) */
  inlineHeight?: string
  /** Additional controls to show in fullscreen header (e.g., refresh button, filters) */
  headerControls?: ReactNode
  /** Footer content to show below the graph (e.g., legend, stats) */
  footer?: ReactNode
  /** Additional className for the inline container */
  className?: string
  /** Whether the fullscreen button is disabled */
  disabled?: boolean
}

/**
 * Wrapper component that adds fullscreen/focus mode capability to graph views.
 * Renders the graph inline with a fullscreen toggle button, and opens a
 * near-full-viewport dialog when toggled.
 */
export function FullscreenGraphWrapper({
  children,
  title = 'Graph View',
  subtitle,
  inlineHeight = '600px',
  headerControls,
  footer,
  className,
  disabled = false,
}: FullscreenGraphWrapperProps) {
  const [isFullscreen, setIsFullscreen] = useState(false)

  return (
    <>
      {/* Inline view with fullscreen toggle */}
      <div className={cn('relative', className)}>
        <div style={{ height: inlineHeight }} className="relative">
          {children}

          {/* Fullscreen toggle button */}
          <Button
            variant="outline"
            size="icon"
            className="absolute top-2 right-2 z-10 bg-white/90 dark:bg-slate-800/90 hover:bg-white dark:hover:bg-slate-800 shadow-sm"
            onClick={() => setIsFullscreen(true)}
            disabled={disabled}
            aria-label="Open fullscreen view"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
        </div>

        {/* Inline footer */}
        {footer && <div className="mt-4">{footer}</div>}
      </div>

      {/* Fullscreen dialog */}
      <DialogPrimitive.Root open={isFullscreen} onOpenChange={setIsFullscreen}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
          <DialogPrimitive.Content
            className={cn(
              'fixed inset-4 z-50 flex flex-col',
              'bg-white dark:bg-slate-950',
              'border border-slate-300 dark:border-slate-800 rounded-lg shadow-2xl',
              'data-[state=open]:animate-in data-[state=closed]:animate-out',
              'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
              'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
            )}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-300 dark:border-slate-800 shrink-0">
              <div className="flex items-center gap-4">
                <div>
                  <DialogPrimitive.Title className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                    {title}
                  </DialogPrimitive.Title>
                  {subtitle && (
                    <DialogPrimitive.Description className="text-sm text-slate-500 dark:text-slate-400">
                      {subtitle}
                    </DialogPrimitive.Description>
                  )}
                </div>
                {headerControls && (
                  <div className="flex items-center gap-2">
                    {headerControls}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setIsFullscreen(false)}
                  aria-label="Exit fullscreen"
                >
                  <Minimize2 className="h-4 w-4" />
                </Button>
                <DialogPrimitive.Close asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Close fullscreen view"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </DialogPrimitive.Close>
              </div>
            </div>

            {/* Graph content - takes remaining space */}
            <div className="flex-1 min-h-0 overflow-hidden">{children}</div>

            {/* Footer */}
            {footer && (
              <div className="px-4 py-3 border-t border-slate-300 dark:border-slate-800 shrink-0">
                {footer}
              </div>
            )}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  )
}
