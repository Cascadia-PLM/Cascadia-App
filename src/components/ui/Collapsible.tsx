import * as CollapsiblePrimitive from '@radix-ui/react-collapsible'
import { forwardRef } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'

const Collapsible = CollapsiblePrimitive.Root

const CollapsibleTrigger = forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger> & {
    chevron?: boolean
  }
>(({ className, children, chevron = true, asChild, ...props }, ref) => {
  // When asChild is true, pass children directly without any wrapper content
  // (Radix Slot requires exactly one child element)
  if (asChild) {
    return (
      <CollapsiblePrimitive.Trigger
        ref={ref}
        asChild
        className={className}
        {...props}
      >
        {children}
      </CollapsiblePrimitive.Trigger>
    )
  }

  // Default behavior: render trigger with optional chevron
  return (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      className={cn(
        'flex w-full items-center justify-between gap-2 transition-all [&[data-state=open]>svg]:rotate-180',
        className,
      )}
      {...props}
    >
      {children}
      {chevron && (
        <ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-200" />
      )}
    </CollapsiblePrimitive.Trigger>
  )
})
CollapsibleTrigger.displayName = CollapsiblePrimitive.Trigger.displayName

const CollapsibleContent = forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Content>
>(({ className, children, ...props }, ref) => (
  <CollapsiblePrimitive.Content
    ref={ref}
    className={cn(
      'overflow-hidden transition-all data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down',
      className,
    )}
    {...props}
  >
    {children}
  </CollapsiblePrimitive.Content>
))
CollapsibleContent.displayName = CollapsiblePrimitive.Content.displayName

export { Collapsible, CollapsibleTrigger, CollapsibleContent }
