import * as React from 'react'
import { Input } from './Input'
import { Textarea } from './Textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './Select'
import { Badge } from './Badge'
import { cn } from '@/lib/utils'

interface BaseFieldProps {
  label: string
  isEditing: boolean
  className?: string
  required?: boolean
}

// Text Field
interface ViewEditTextProps extends BaseFieldProps {
  value: string | null | undefined
  onChange: (value: string) => void
  placeholder?: string
  emptyText?: string
  inputType?: string
  'data-testid'?: string
}

export function ViewEditText({
  label,
  value,
  onChange,
  isEditing,
  placeholder,
  emptyText = '-',
  inputType,
  className,
  required,
  'data-testid': testId,
}: ViewEditTextProps) {
  return (
    <div className={className}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
        {required && isEditing && <span className="text-red-500 ml-1">*</span>}
      </dt>
      <dd className="mt-1">
        {isEditing ? (
          <Input
            type={inputType ?? 'text'}
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            className="w-full"
            data-testid={testId}
          />
        ) : (
          <span className="text-lg text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
            {value || emptyText}
          </span>
        )}
      </dd>
    </div>
  )
}

// Textarea Field
interface ViewEditTextareaProps extends BaseFieldProps {
  value: string | null | undefined
  onChange: (value: string) => void
  placeholder?: string
  emptyText?: string
  rows?: number
}

export function ViewEditTextarea({
  label,
  value,
  onChange,
  isEditing,
  placeholder,
  emptyText = '-',
  rows = 3,
  className,
  required,
}: ViewEditTextareaProps) {
  return (
    <div className={className}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
        {required && isEditing && <span className="text-red-500 ml-1">*</span>}
      </dt>
      <dd className="mt-1">
        {isEditing ? (
          <Textarea
            value={value || ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            rows={rows}
            className="w-full"
          />
        ) : (
          <span className="text-slate-900 dark:text-white whitespace-pre-wrap bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md block">
            {value || emptyText}
          </span>
        )}
      </dd>
    </div>
  )
}

// Select Field
interface SelectOption {
  value: string
  label: string
}

interface ViewEditSelectProps extends BaseFieldProps {
  value: string | null | undefined
  onChange: (value: string) => void
  options: Array<SelectOption>
  placeholder?: string
  emptyText?: string
  'data-testid'?: string
}

export function ViewEditSelect({
  label,
  value,
  onChange,
  isEditing,
  options,
  placeholder = 'Select...',
  emptyText = '-',
  className,
  required,
  'data-testid': testId,
}: ViewEditSelectProps) {
  const selectedOption = options.find((opt) => opt.value === value)

  return (
    <div className={className} data-testid={testId}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
        {required && isEditing && <span className="text-red-500 ml-1">*</span>}
      </dt>
      <dd className="mt-1">
        {isEditing ? (
          <Select value={value || ''} onValueChange={onChange}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <span className="text-lg text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
            {selectedOption?.label || emptyText}
          </span>
        )}
      </dd>
    </div>
  )
}

// Number Field with optional unit
interface ViewEditNumberProps extends BaseFieldProps {
  value: number | string | null | undefined
  onChange: (value: string) => void
  unit?: string
  unitOptions?: Array<SelectOption>
  unitValue?: string
  onUnitChange?: (value: string) => void
  placeholder?: string
  emptyText?: string
  step?: string
  min?: number
  max?: number
}

export function ViewEditNumber({
  label,
  value,
  onChange,
  isEditing,
  unit,
  unitOptions,
  unitValue,
  onUnitChange,
  placeholder,
  emptyText = '-',
  step = '1',
  min,
  max,
  className,
  required,
}: ViewEditNumberProps) {
  const displayValue =
    value !== null && value !== undefined && value !== ''
      ? `${value}${unit ? ` ${unit}` : ''}${unitValue ? ` ${unitValue}` : ''}`
      : emptyText

  return (
    <div className={className}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
        {required && isEditing && <span className="text-red-500 ml-1">*</span>}
      </dt>
      <dd className="mt-1">
        {isEditing ? (
          <div className="flex gap-2">
            <Input
              type="number"
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              step={step}
              min={min}
              max={max}
              className="flex-1"
            />
            {unitOptions && onUnitChange ? (
              <Select value={unitValue || ''} onValueChange={onUnitChange}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {unitOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : unit ? (
              <span className="flex items-center text-slate-600 dark:text-slate-400 px-2">
                {unit}
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-lg text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
            {displayValue}
          </span>
        )}
      </dd>
    </div>
  )
}

// Currency Field
interface ViewEditCurrencyProps extends BaseFieldProps {
  value: number | string | null | undefined
  onChange: (value: string) => void
  currency?: string
  currencyOptions?: Array<SelectOption>
  onCurrencyChange?: (value: string) => void
  placeholder?: string
  emptyText?: string
}

export function ViewEditCurrency({
  label,
  value,
  onChange,
  isEditing,
  currency = 'USD',
  currencyOptions,
  onCurrencyChange,
  placeholder,
  emptyText = '-',
  className,
  required,
}: ViewEditCurrencyProps) {
  const displayValue =
    value !== null && value !== undefined && value !== ''
      ? `${currency} ${parseFloat(String(value)).toFixed(2)}`
      : emptyText

  return (
    <div className={className}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
        {required && isEditing && <span className="text-red-500 ml-1">*</span>}
      </dt>
      <dd className="mt-1">
        {isEditing ? (
          <div className="flex gap-2">
            {currencyOptions && onCurrencyChange ? (
              <Select value={currency} onValueChange={onCurrencyChange}>
                <SelectTrigger className="w-24">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencyOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="flex items-center text-slate-600 dark:text-slate-400 px-2">
                {currency}
              </span>
            )}
            <Input
              type="number"
              value={value ?? ''}
              onChange={(e) => onChange(e.target.value)}
              placeholder={placeholder}
              step="0.01"
              className="flex-1"
            />
          </div>
        ) : (
          <span className="text-lg font-semibold text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
            {displayValue}
          </span>
        )}
      </dd>
    </div>
  )
}

// Badge/Status Field (read-only displays as badge, edit mode uses select)
interface ViewEditBadgeProps extends BaseFieldProps {
  value: string | null | undefined
  onChange: (value: string) => void
  options: Array<SelectOption>
  variant?: (
    value: string,
  ) =>
    | 'default'
    | 'secondary'
    | 'success'
    | 'warning'
    | 'destructive'
    | 'outline'
  placeholder?: string
  emptyText?: string
  readOnly?: boolean // Some badge fields are always read-only (like state)
}

export function ViewEditBadge({
  label,
  value,
  onChange,
  isEditing,
  options,
  variant,
  placeholder = 'Select...',
  emptyText = '-',
  readOnly = false,
  className,
  required,
}: ViewEditBadgeProps) {
  const selectedOption = options.find((opt) => opt.value === value)
  const badgeVariant = variant ? variant(value || '') : 'default'

  return (
    <div className={className}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
        {required && isEditing && !readOnly && (
          <span className="text-red-500 ml-1">*</span>
        )}
      </dt>
      <dd className="mt-1">
        {isEditing && !readOnly ? (
          <Select value={value || ''} onValueChange={onChange}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={placeholder} />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : value ? (
          <Badge variant={badgeVariant}>{selectedOption?.label || value}</Badge>
        ) : (
          <span className="text-slate-500">{emptyText}</span>
        )}
      </dd>
    </div>
  )
}

// Static display field (always read-only, used for IDs, dates, etc.)
interface ViewEditStaticProps {
  label: string
  value: React.ReactNode
  className?: string
  mono?: boolean
}

export function ViewEditStatic({
  label,
  value,
  className,
  mono = false,
}: ViewEditStaticProps) {
  return (
    <div className={className}>
      <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd
        className={cn(
          'mt-1 text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md inline-block',
          mono && 'text-sm font-mono text-slate-600 dark:text-slate-400',
        )}
      >
        {value || '-'}
      </dd>
    </div>
  )
}
