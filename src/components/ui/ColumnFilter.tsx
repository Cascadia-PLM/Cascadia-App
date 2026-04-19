import { useEffect, useMemo, useRef, useState } from 'react'
import { Filter, X } from 'lucide-react'
import { Button } from './Button'
import { Input } from './Input'
import { Checkbox } from './Checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './Select'
import { Popover, PopoverContent, PopoverTrigger } from './Popover'
import { cn } from '@/lib/utils'

// Filter types
export type FilterType = 'text' | 'select' | 'multiSelect' | 'range'

// Range filter value
export interface RangeFilterValue {
  min?: number
  max?: number
}

// Multi-select filter value is an array of strings
export type MultiSelectFilterValue = Array<string>

// Column Filter Popover - handles all filter types
export function ColumnFilterPopover({
  filterType,
  value,
  onChange,
  options,
  placeholder,
  columnHeader,
  open,
  onOpenChange,
}: {
  filterType: FilterType
  value: unknown
  onChange: (value: unknown) => void
  options?: Array<{ label: string; value: string }>
  placeholder?: string
  columnHeader: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  // Check if filter is active
  const isActive = useMemo(() => {
    if (value === undefined || value === null || value === '') return false
    if (Array.isArray(value) && value.length === 0) return false
    if (typeof value === 'object') {
      const rangeVal = value as RangeFilterValue
      return rangeVal.min !== undefined || rangeVal.max !== undefined
    }
    return true
  }, [value])

  const setOpen = onOpenChange

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'p-0.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800',
            isActive && 'text-cyan-600 dark:text-cyan-400',
          )}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Filter ${columnHeader}`}
          aria-expanded={open}
        >
          <Filter className={cn('h-3 w-3', isActive ? 'fill-current' : '')} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-56 p-3"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="space-y-3">
          <div className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Filter {columnHeader}
          </div>

          {filterType === 'text' && (
            <TextFilterContent
              value={(value as string) || ''}
              onChange={onChange}
              placeholder={placeholder}
            />
          )}

          {filterType === 'select' && (
            <SelectFilterContent
              value={(value as string) || ''}
              onChange={(v) => {
                onChange(v)
                setOpen(false)
              }}
              options={options ?? []}
              placeholder={placeholder}
            />
          )}

          {filterType === 'multiSelect' && (
            <MultiSelectFilterContent
              value={(value as Array<string> | undefined) ?? []}
              onChange={onChange}
              options={options ?? []}
            />
          )}

          {filterType === 'range' && (
            <RangeFilterContent
              value={(value as RangeFilterValue | undefined) ?? {}}
              onChange={(v) => {
                onChange(v)
              }}
              onClose={() => setOpen(false)}
            />
          )}

          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full h-8 text-xs text-slate-500"
              onClick={() => {
                onChange(
                  filterType === 'multiSelect'
                    ? []
                    : filterType === 'range'
                      ? {}
                      : '',
                )
                setOpen(false)
              }}
            >
              <X className="h-3 w-3 mr-1" />
              Clear filter
            </Button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// Text filter content
export function TextFilterContent({
  value,
  onChange,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  placeholder?: string
}) {
  const [localValue, setLocalValue] = useState(value)
  const debounceRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleChange = (newValue: string) => {
    setLocalValue(newValue)
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
    }
    debounceRef.current = setTimeout(() => {
      onChange(newValue)
    }, 300)
  }

  return (
    <div className="relative">
      <Input
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder || 'Type to filter...'}
        className="h-8 text-sm pr-8"
        autoFocus
      />
      {localValue && (
        <button
          onClick={() => handleChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
          aria-label="Clear filter text"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  )
}

// Select filter content
export function SelectFilterContent({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string
  onChange: (value: string) => void
  options: Array<{ label: string; value: string }>
  placeholder?: string
}) {
  return (
    <Select
      value={value || '__all__'}
      onValueChange={(v) => onChange(v === '__all__' ? '' : v)}
    >
      <SelectTrigger className="h-8 text-sm">
        <SelectValue placeholder={placeholder || 'Select...'} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__all__">All</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Multi-select filter content
export function MultiSelectFilterContent({
  value,
  onChange,
  options,
}: {
  value: Array<string>
  onChange: (value: Array<string>) => void
  options: Array<{ label: string; value: string }>
}) {
  const handleToggle = (optionValue: string) => {
    if (value.includes(optionValue)) {
      onChange(value.filter((v) => v !== optionValue))
    } else {
      onChange([...value, optionValue])
    }
  }

  return (
    <div className="space-y-1 max-h-48 overflow-y-auto">
      {options.map((option) => (
        <label
          key={option.value}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer text-sm"
        >
          <Checkbox
            checked={value.includes(option.value)}
            onCheckedChange={() => handleToggle(option.value)}
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}

// Range filter content
export function RangeFilterContent({
  value,
  onChange,
  onClose,
}: {
  value: RangeFilterValue
  onChange: (value: RangeFilterValue) => void
  onClose: () => void
}) {
  const [localMin, setLocalMin] = useState(value.min?.toString() || '')
  const [localMax, setLocalMax] = useState(value.max?.toString() || '')

  useEffect(() => {
    setLocalMin(value.min?.toString() || '')
    setLocalMax(value.max?.toString() || '')
  }, [value])

  const handleApply = () => {
    const min = localMin ? parseFloat(localMin) : undefined
    const max = localMax ? parseFloat(localMax) : undefined
    onChange({ min, max })
    onClose()
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="text-xs text-slate-500 mb-1 block">Min</label>
        <Input
          type="number"
          value={localMin}
          onChange={(e) => setLocalMin(e.target.value)}
          placeholder="No min"
          className="h-8 text-sm"
        />
      </div>
      <div>
        <label className="text-xs text-slate-500 mb-1 block">Max</label>
        <Input
          type="number"
          value={localMax}
          onChange={(e) => setLocalMax(e.target.value)}
          placeholder="No max"
          className="h-8 text-sm"
        />
      </div>
      <Button size="sm" className="w-full h-8 text-xs" onClick={handleApply}>
        Apply
      </Button>
    </div>
  )
}
