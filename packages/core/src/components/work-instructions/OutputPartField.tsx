// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, X } from 'lucide-react'
import { Badge, Button, FormField, Input } from '@/components/ui'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { itemTextSearchQuery } from '@/lib/query/options/item-search'
import { cn } from '@/lib/utils'

interface PartSearchResult {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  designCode?: string | null
  designName?: string | null
}

interface OutputPartFieldProps {
  value?: string
  onChange: (partId: string | undefined, part?: PartSearchResult) => void
  error?: string
  disabled?: boolean
}

/**
 * Picks the part a work instruction builds.
 *
 * This is the field the work instruction's design is derived from, so it is
 * required at creation and the chosen part's design is surfaced in the summary
 * — an author picking the wrong revision of the right part number should be
 * able to see that before saving.
 */
export function OutputPartField({
  value,
  onChange,
  error,
  disabled,
}: OutputPartFieldProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<PartSearchResult | undefined>()
  const debounced = useDebouncedValue(query)

  const { data: results = [], isFetching } = useQuery(
    itemTextSearchQuery<PartSearchResult>(
      { q: debounced, types: ['Part'], limit: 10 },
      debounced.length >= 2 && !selected,
    ),
  )

  const select = (part: PartSearchResult) => {
    setSelected(part)
    setQuery('')
    onChange(part.id, part)
  }

  const clear = () => {
    setSelected(undefined)
    setQuery('')
    onChange(undefined)
  }

  return (
    <FormField
      label="Output Part"
      required
      error={error}
      className="md:col-span-2"
      helpText="The part this procedure builds. Determines which design the work instruction belongs to."
    >
      {selected || value ? (
        <div className="flex items-center justify-between gap-3 rounded-md border bg-slate-50 p-3 dark:border-slate-700 dark:bg-slate-800/50">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sky-600 dark:text-sky-400">
                {selected?.itemNumber ?? value}
              </span>
              {selected && (
                <Badge variant="secondary" className="text-xs">
                  Rev {selected.revision}
                </Badge>
              )}
              {selected?.designCode && (
                <Badge variant="outline" className="text-xs">
                  {selected.designCode}
                </Badge>
              )}
            </div>
            {selected?.name && (
              <p className="truncate text-sm text-slate-600 dark:text-slate-400">
                {selected.name}
              </p>
            )}
          </div>
          {!disabled && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={clear}
              aria-label="Clear output part"
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search by part number or name..."
              className="pl-9"
              error={!!error}
              disabled={disabled}
            />
          </div>

          {isFetching && (
            <p className="py-1 text-sm text-slate-500">Searching...</p>
          )}
          {!isFetching && debounced.length >= 2 && results.length === 0 && (
            <p className="py-1 text-sm text-slate-500">
              No parts found matching "{debounced}"
            </p>
          )}
          {results.length > 0 && (
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border p-1 dark:border-slate-700">
              {results.map((part) => (
                <button
                  key={part.id}
                  type="button"
                  onClick={() => select(part)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md p-2 text-left',
                    'transition-colors hover:bg-slate-100 dark:hover:bg-slate-700',
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sky-600 dark:text-sky-400">
                        {part.itemNumber}
                      </span>
                      <Badge variant="secondary" className="text-xs">
                        Rev {part.revision}
                      </Badge>
                      {part.designCode && (
                        <Badge variant="outline" className="text-xs">
                          {part.designCode}
                        </Badge>
                      )}
                    </div>
                    <p className="truncate text-sm text-slate-600 dark:text-slate-400">
                      {part.name || 'Unnamed part'}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </FormField>
  )
}
