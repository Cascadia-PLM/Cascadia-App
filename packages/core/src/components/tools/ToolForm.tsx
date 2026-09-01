// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useForm, useStore } from '@tanstack/react-form'
import { useState } from 'react'
import { CapabilitiesEditor } from './CapabilitiesEditor'
import type { Tool } from '@/lib/items/types/tool'
import {
  TOOL_SUBTYPES,
  getSubtypeGroup,
  toolSchema,
} from '@/lib/items/types/tool'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { zodValidator } from '@/lib/form-validation'
import {
  Button,
  FormField,
  Input,
  SearchableSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'

interface ToolFormProps {
  tool?: Partial<Tool>
  onSubmit: (data: Tool) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

const TOOL_TYPE_OPTIONS = [
  { value: 'manufacturing', label: 'Manufacturing' },
  { value: 'quality', label: 'Quality' },
  { value: 'utility', label: 'Utility' },
]

export function ToolForm({
  tool,
  onSubmit,
  onCancel,
  isSubmitting,
}: ToolFormProps) {
  const [capabilities, setCapabilities] = useState<Record<string, unknown>>(
    tool?.capabilities ?? {},
  )
  const [attributes, setAttributes] = useState<Record<string, unknown>>(
    tool?.attributes ?? {},
  )

  const form = useForm({
    defaultValues: {
      itemType: 'Tool' as const,
      toolType: 'manufacturing' as 'manufacturing' | 'quality' | 'utility',
      toolSubtype: '',
      manufacturer: '',
      model: '',
      location: '',
      notes: '',
      name: '',
      itemNumber: '',
      ...tool,
    },
    validators: {
      onSubmit: zodValidator(toolSchema),
    },
    onSubmit: async ({ value }) => {
      const submissionData = {
        ...value,
        attributes,
        capabilities:
          Object.keys(capabilities).length > 0 ? capabilities : undefined,
      } as Tool
      await onSubmit(submissionData)
    },
  })

  const currentToolType = useStore(form.store, (s) => s.values.toolType)
  const currentSubtype = useStore(form.store, (s) => s.values.toolSubtype)

  // Filter subtypes by current tool type, with groups for searchable dropdown
  const subtypeOptions = Object.entries(TOOL_SUBTYPES)
    .filter(([, meta]) => meta.toolType === currentToolType)
    .map(([key, meta]) => ({
      value: key,
      label: meta.label,
      group: getSubtypeGroup(key),
    }))

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-4"
    >
      {/* Name */}
      <form.Field name="name">
        {(field) => (
          <FormField label="Name" error={field.state.meta.errors[0]}>
            <Input
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="e.g., Prusa MK4S"
            />
          </FormField>
        )}
      </form.Field>

      {/* Tool Type */}
      <form.Field name="toolType">
        {(field) => (
          <FormField label="Tool Type" error={field.state.meta.errors[0]}>
            <Select
              value={field.state.value}
              onValueChange={(v) =>
                field.handleChange(v as 'manufacturing' | 'quality' | 'utility')
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                {TOOL_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
      </form.Field>

      {/* Tool Subtype */}
      <form.Field name="toolSubtype">
        {(field) => (
          <FormField label="Subtype" error={field.state.meta.errors[0]}>
            <SearchableSelect
              value={field.state.value}
              onValueChange={(v) => field.handleChange(v)}
              options={[...subtypeOptions, { value: 'other', label: 'Other' }]}
              placeholder="Search subtypes..."
              searchPlaceholder="Type to filter..."
            />
          </FormField>
        )}
      </form.Field>

      {/* Manufacturer + Model row */}
      <div className="grid grid-cols-2 gap-4">
        <form.Field name="manufacturer">
          {(field) => (
            <FormField label="Manufacturer" error={field.state.meta.errors[0]}>
              <Input
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="e.g., Prusa Research"
              />
            </FormField>
          )}
        </form.Field>

        <form.Field name="model">
          {(field) => (
            <FormField label="Model" error={field.state.meta.errors[0]}>
              <Input
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="e.g., MK4S"
              />
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Location row — the flow position is the lifecycle state, moved by
          transitions, not a form field */}
      <div className="grid grid-cols-2 gap-4">
        <form.Field name="location">
          {(field) => (
            <FormField label="Location" error={field.state.meta.errors[0]}>
              <Input
                value={field.state.value}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="e.g., Workshop bench 3"
              />
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Capabilities — typed fields for known subtypes, freeform otherwise */}
      {currentSubtype && (
        <CapabilitiesEditor
          subtype={currentSubtype}
          capabilities={capabilities}
          onChange={setCapabilities}
        />
      )}

      {/* Notes */}
      <form.Field name="notes">
        {(field) => (
          <FormField label="Notes" error={field.state.meta.errors[0]}>
            <Textarea
              value={field.state.value}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="Free-form notes about this tool..."
              rows={3}
            />
          </FormField>
        )}
      </form.Field>

      {/* Custom Attributes */}
      <AttributesEditor value={attributes} onChange={setAttributes} />

      {/* Actions */}
      <div className="flex justify-end gap-2 pt-4">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Saving...'
            : tool?.id
              ? 'Update Tool'
              : 'Create Tool'}
        </Button>
      </div>
    </form>
  )
}
