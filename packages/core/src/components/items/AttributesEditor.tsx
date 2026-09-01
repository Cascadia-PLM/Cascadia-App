// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
  value: Record<string, unknown>
  onChange: (attributes: Record<string, unknown>) => void
  disabled?: boolean
  /** Additional classes for the outer border wrapper (use 'border-0' to suppress when inside a Card) */
  className?: string
}

/**
 * Render one attribute value as display text.
 *
 * `items.attributes` is a JSON document, so a value can be an object or an
 * array. Passing one of those to React as a child throws, and `String(v)`
 * gives `[object Object]` - both of which this replaces. Exported because
 * every read-only attribute list on an item detail page needs the same thing.
 */
export function formatAttributeValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    // A circular structure is not something the column can hold, but the
    // editor should still render the row rather than throw.
    return String(value)
  }
}

/**
 * A reusable component for editing key-value attributes on items.
 * Renders inside a collapsible section with add/edit/remove operations.
 *
 * Editing is for string values, which is what a person types here. A
 * structured value - a catalog snapshot written by design-engine
 * materialization, say - is shown read-only as JSON and passed back through
 * `onChange` untouched, because every caller saves the whole map: coercing it
 * into this editor's text input would destroy it on the next save of any
 * unrelated field. Renaming its key and deleting it still work.
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
    const newAttributes: Record<string, unknown> = {}
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
                {entries.map(([key, val], index) => {
                  const isText = typeof val === 'string'
                  return (
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
                        value={formatAttributeValue(val)}
                        onChange={(e) => handleValueChange(key, e.target.value)}
                        placeholder="Value"
                        className={cn(
                          'flex-1',
                          !isText && 'text-muted-foreground',
                        )}
                        disabled={disabled}
                        readOnly={!isText}
                        title={
                          isText
                            ? undefined
                            : 'Structured value — edit it where it is written, or remove it here'
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={() => handleRemove(key)}
                        disabled={disabled}
                        className="text-red-500 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/20 shrink-0"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })}
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
