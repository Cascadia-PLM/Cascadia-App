import type { Design } from '@/lib/types/design'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface DesignSelectorProps {
  /** List of designs to display in the dropdown */
  designs: Array<Design>
  /** Currently selected design ID */
  value?: string
  /** Callback when selection changes */
  onChange: (designId: string) => void
  /** Placeholder text when no design is selected */
  placeholder?: string
  /** Whether selection is required (disables "None" option) */
  required?: boolean
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Custom className for the trigger */
  className?: string
}

/**
 * DesignSelector - Dropdown for selecting a design
 *
 * Used in item forms (Parts, Documents, Requirements) to link items to designs.
 * When a design is selected, items will be associated with that design's
 * versioning system (branches, commits, etc.)
 *
 * @example
 * ```tsx
 * <DesignSelector
 *   designs={designs}
 *   value={designId}
 *   onChange={(id) => setDesignId(id)}
 *   required
 * />
 * ```
 */
export function DesignSelector({
  designs,
  value,
  onChange,
  placeholder = 'Select a design',
  required = false,
  disabled = false,
  className,
}: DesignSelectorProps) {
  // Sort designs by code for consistent ordering
  const sortedDesigns = [...designs].sort((a, b) =>
    (a.code || '').localeCompare(b.code || ''),
  )

  // Filter out library designs (they're special)
  const regularDesigns = sortedDesigns.filter((p) => p.designType !== 'Library')
  const libraryDesigns = sortedDesigns.filter((p) => p.designType === 'Library')

  // Radix Select doesn't handle empty string well - use undefined for uncontrolled state
  // Only pass value if it's a valid UUID (not empty string)
  const selectValue = value && value.length > 0 ? value : undefined

  return (
    <Select
      value={selectValue}
      onValueChange={(newValue) => {
        if (newValue === 'none') {
          onChange('')
        } else {
          onChange(newValue)
        }
      }}
      disabled={disabled}
    >
      <SelectTrigger className={className} data-testid="design-selector">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {!required && (
          <SelectItem value="none" className="text-muted-foreground">
            No Design
          </SelectItem>
        )}

        {/* Regular designs */}
        {regularDesigns.map((design) => (
          <SelectItem key={design.id} value={design.id}>
            <span className="font-medium">{design.code}</span>
            <span className="ml-2 text-muted-foreground">{design.name}</span>
          </SelectItem>
        ))}

        {/* Library designs (if any) - shown separately */}
        {libraryDesigns.length > 0 && regularDesigns.length > 0 && (
          <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">
            Libraries
          </div>
        )}
        {libraryDesigns.map((design) => (
          <SelectItem key={design.id} value={design.id}>
            <span className="font-medium">{design.code}</span>
            <span className="ml-2 text-muted-foreground">{design.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * Get design display text (code - name)
 */
export function getDesignDisplayText(design: Design | undefined): string {
  if (!design) return 'Unknown Design'
  return `${design.code} - ${design.name}`
}
