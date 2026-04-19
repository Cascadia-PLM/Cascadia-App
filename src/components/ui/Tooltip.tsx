import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { forwardRef } from 'react'
import type { ComponentPropsWithoutRef, ElementRef } from 'react'
import { cn } from '@/lib/utils'

/**
 * TooltipProvider wraps your app to enable tooltips.
 * Only needed once at the app root level.
 */
const TooltipProvider = TooltipPrimitive.Provider

/**
 * Tooltip root component that manages open state.
 */
const Tooltip = TooltipPrimitive.Root

/**
 * TooltipTrigger wraps the element that triggers the tooltip.
 * Use asChild prop to merge with the child element.
 */
const TooltipTrigger = TooltipPrimitive.Trigger

/**
 * TooltipContent displays the tooltip content.
 * Automatically handles positioning and animations.
 */
const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 overflow-hidden rounded-md px-3 py-1.5 text-xs',
        'bg-slate-900 text-slate-50',
        'dark:bg-slate-50 dark:text-slate-900',
        'animate-in fade-in-0 zoom-in-95',
        'data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        'data-[side=bottom]:slide-in-from-top-2',
        'data-[side=left]:slide-in-from-right-2',
        'data-[side=right]:slide-in-from-left-2',
        'data-[side=top]:slide-in-from-bottom-2',
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
))
TooltipContent.displayName = TooltipPrimitive.Content.displayName

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
