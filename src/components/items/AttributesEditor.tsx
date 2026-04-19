import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Input,
} from '@/components/ui'

interface AttributesEditorProps {
  value: Record<string, string>
  onChange: (attributes: Record<string, string>) => void
  disabled?: boolean
  /** Additional classes for the outer border wrapper (use 'border-0' to suppress when inside a Card) */
  className?: string
}

/**
 * A reusable component for editing key-value attributes on items.
 * Renders inside a collapsible section with add/edit/remove operations.
 */
export function AttributesEditor({
  value,
  onChange,
  disabled = false,
  className,
}: AttributesEditorProps) {
  const [isOpen, setIsOpen] = useState(false)

  const entries = Object.entries(value)
  const attributeCount = entries.length

  const handleAddAttribute = () => {
    // Find a unique key name
    let index = 1
    let newKey = `attribute${index}`
    while (newKey in value) {
      index++
      newKey = `attribute${index}`
    }
    onChange({ ...value, [newKey]: '' })
    setIsOpen(true)
  }

  const handleKeyChange = (oldKey: string, newKey: string) => {
    if (oldKey === newKey || !newKey.trim()) return

    // Build new object preserving order, replacing old key with new key
    const newAttributes: Record<string, string> = {}
    for (const [key, val] of Object.entries(value)) {
      if (key === oldKey) {
        newAttributes[newKey.trim()] = val
      } else {
        newAttributes[key] = val
      }
    }
    onChange(newAttributes)
  }

  const handleValueChange = (key: string, newValue: string) => {
    onChange({ ...value, [key]: newValue })
  }

  const handleRemove = (keyToRemove: string) => {
    const { [keyToRemove]: _, ...rest } = value
    onChange(rest)
  }

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div className={cn('border rounded-lg', className)}>
        <CollapsibleTrigger className="flex w-full items-center justify-between p-4 text-left hover:bg-slate-50 dark:hover:bg-slate-800 rounded-lg transition-colors">
          <div className="flex items-center gap-3">
            <span className="text-2xl font-semibold leading-none tracking-tight">
              Custom Attributes
            </span>
            {attributeCount > 0 && (
              <Badge variant="secondary">{attributeCount}</Badge>
            )}
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-4 pb-4 space-y-3">
            {entries.length === 0 ? (
              <p className="text-sm text-muted-foreground py-2">
                No custom attributes defined. Add attributes to store additional
                metadata on this item.
              </p>
            ) : (
              <div className="space-y-2">
                {entries.map(([key, val], index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      value={key}
                      onChange={(e) => handleKeyChange(key, e.target.value)}
                      onBlur={(e) => {
                        // Clean up empty keys on blur
                        if (!e.target.value.trim()) {
                          handleRemove(key)
                        }
                      }}
                      placeholder="Key"
                      className="flex-1"
                      disabled={disabled}
                    />
                    <Input
                      value={val}
                      onChange={(e) => handleValueChange(key, e.target.value)}
                      placeholder="Value"
                      className="flex-1"
                      disabled={disabled}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => handleRemove(key)}
                      disabled={disabled}
                      className="text-red-500 hover:text-red-700 hover:bg-red-100 dark:hover:bg-red-900/20 shrink-0"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddAttribute}
              disabled={disabled}
              className="mt-2"
            >
              <Plus className="h-4 w-4 mr-2" />
              Add Attribute
            </Button>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
