// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { FormField, Input } from '@/components/ui'
import {
  ITEM_NUMBER_PLACEHOLDER,
  getItemNumberHelpText,
} from '@/lib/items/numbering/format'

interface ItemNumberFieldProps {
  /** Item type key (e.g. 'Part') — drives the format example in the help text. */
  itemType: string
  value: string
  onChange: (value: string) => void
  onBlur?: () => void
  error?: string
  /** Field label. Defaults to "Item Number". */
  label?: string
  name?: string
  disabled?: boolean
  className?: string
  'data-testid'?: string
}

/**
 * Shared item-number input for create/edit forms.
 *
 * Centralizes the placeholder and help-text wording so every item type says the
 * same thing, and surfaces the type's auto-generated format (e.g. `PN-000001`).
 * Leaving the field blank is always valid — the server auto-generates the
 * number (see `baseItemSchema.itemNumber`).
 */
export function ItemNumberField({
  itemType,
  value,
  onChange,
  onBlur,
  error,
  label = 'Item Number',
  name,
  disabled,
  className,
  'data-testid': testId,
}: ItemNumberFieldProps) {
  return (
    <FormField
      label={label}
      error={error}
      helpText={getItemNumberHelpText(itemType)}
      className={className}
    >
      <Input
        name={name}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={ITEM_NUMBER_PLACEHOLDER}
        error={!!error}
        disabled={disabled}
        data-testid={testId}
      />
    </FormField>
  )
}
