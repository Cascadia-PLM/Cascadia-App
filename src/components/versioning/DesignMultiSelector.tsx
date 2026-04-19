import { useState } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import type { Design } from '@/lib/types/design'
import { cn } from '@/lib/utils'
import {
  Badge,
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui'

interface DesignMultiSelectorProps {
  /** List of designs to display */
  designs: Array<Design>
  /** Currently selected design IDs */
  value: Array<string>
  /** Callback when selection changes */
  onChange: (designIds: Array<string>) => void
  /** Placeholder text when no designs are selected */
  placeholder?: string
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Custom className for the trigger */
  className?: string
}

/**
 * DesignMultiSelector - Multi-select dropdown for selecting multiple designs
 *
 * Used for Issues to associate them with multiple designs without branch control.
 * Displays selected designs as badges that can be removed individually.
 *
 * @example
 * ```tsx
 * <DesignMultiSelector
 *   designs={designs}
 *   value={selectedDesignIds}
 *   onChange={(ids) => setSelectedDesignIds(ids)}
 * />
 * ```
 */
export function DesignMultiSelector({
  designs,
  value,
  onChange,
  placeholder = 'Select designs...',
  disabled = false,
  className,
}: DesignMultiSelectorProps) {
  const [open, setOpen] = useState(false)

  // Sort designs by code for consistent ordering
  const sortedDesigns = [...designs].sort((a, b) =>
    (a.code || '').localeCompare(b.code || ''),
  )

  // Filter out library designs (they're special)
  const regularDesigns = sortedDesigns.filter((d) => d.designType !== 'Library')
  const libraryDesigns = sortedDesigns.filter((d) => d.designType === 'Library')

  // Get selected design objects
  const selectedDesigns = value
    .map((id) => designs.find((d) => d.id === id))
    .filter((d): d is Design => d !== undefined)

  const handleToggle = (designId: string) => {
    if (value.includes(designId)) {
      onChange(value.filter((id) => id !== designId))
    } else {
      onChange([...value, designId])
    }
  }

  const handleRemove = (designId: string, e: React.MouseEvent) => {
    e.stopPropagation()
    onChange(value.filter((id) => id !== designId))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn(
            'w-full justify-between min-h-[2.5rem] h-auto',
            className,
          )}
          data-testid="design-multi-selector"
        >
          <div className="flex flex-wrap gap-1 items-center flex-1">
            {selectedDesigns.length === 0 ? (
              <span className="text-muted-foreground">{placeholder}</span>
            ) : (
              selectedDesigns.map((design) => (
                <Badge
                  key={design.id}
                  variant="secondary"
                  className="mr-1 flex items-center gap-1"
                >
                  {design.code}
                  {!disabled && (
                    <X
                      className="h-3 w-3 cursor-pointer hover:text-destructive"
                      onClick={(e) => handleRemove(design.id, e)}
                    />
                  )}
                </Badge>
              ))
            )}
          </div>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <div className="max-h-[300px] overflow-y-auto p-2">
          {designs.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No designs available
            </div>
          ) : (
            <>
              {/* Regular designs */}
              {regularDesigns.map((design) => (
                <DesignCheckboxItem
                  key={design.id}
                  design={design}
                  checked={value.includes(design.id)}
                  onToggle={() => handleToggle(design.id)}
                />
              ))}

              {/* Library designs (if any) - shown separately */}
              {libraryDesigns.length > 0 && regularDesigns.length > 0 && (
                <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground border-t mt-2 pt-2">
                  Libraries
                </div>
              )}
              {libraryDesigns.map((design) => (
                <DesignCheckboxItem
                  key={design.id}
                  design={design}
                  checked={value.includes(design.id)}
                  onToggle={() => handleToggle(design.id)}
                />
              ))}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface DesignCheckboxItemProps {
  design: Design
  checked: boolean
  onToggle: () => void
}

function DesignCheckboxItem({
  design,
  checked,
  onToggle,
}: DesignCheckboxItemProps) {
  return (
    <label
      className={cn(
        'flex items-center gap-3 px-2 py-2 rounded-md cursor-pointer',
        'hover:bg-slate-100 dark:hover:bg-slate-800',
        checked && 'bg-slate-50 dark:bg-slate-900',
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      <div className="flex-1 min-w-0">
        <span className="font-medium">{design.code}</span>
        <span className="ml-2 text-muted-foreground truncate">
          {design.name}
        </span>
      </div>
      {checked && <Check className="h-4 w-4 text-primary shrink-0" />}
    </label>
  )
}
