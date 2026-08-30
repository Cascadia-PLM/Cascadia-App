// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useForm } from '@tanstack/react-form'
import { Loader2, Search } from 'lucide-react'
import { z } from 'zod'
import type { WorkOrderCreateInput } from '@/lib/items/types/work-order'
import {
  Button,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'
import { entityQuery, itemTextSearchQuery, programListQuery } from '@/lib/query'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import { zodValidator } from '@/lib/form-validation'

interface PartSearchResult {
  id: string
  itemNumber: string
  name?: string
  revision: string
}

/**
 * A work order is gated on the program it names, and a program-less order is
 * reachable by an administrator alone. The server derives the program from the
 * part being built, so a part is enough — but an order with no part has
 * nothing to derive from, and would land invisible to the person who filed it.
 * Requiring a program in that case is a client-side rule on purpose: the v1
 * request body keeps `programId` optional, so the contract stays additive.
 */
const workOrderFormSchema = z
  .object({
    partId: z.string().nullable(),
    programId: z.string(),
  })
  .superRefine((value, ctx) => {
    if (!value.partId && !value.programId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['programId'],
        message: 'Choose a program when no part is selected',
      })
    }
  })

interface WorkOrderFormProps {
  defaultValues?: Partial<WorkOrderCreateInput & { partId: string }>
  onSubmit: (data: WorkOrderCreateInput) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

export function WorkOrderForm({
  defaultValues,
  onSubmit,
  onCancel,
  isSubmitting,
}: WorkOrderFormProps) {
  const [partSearch, setPartSearch] = useState('')
  // What the user picked in this form, which wins over the prefilled part.
  // `null` after an explicit Change means "cleared", so the prefilled part
  // does not come back.
  const [pickedPart, setPickedPart] = useState<PartSearchResult | null>(null)
  const [cleared, setCleared] = useState(false)

  const { data: prefilledPart } = useQuery(
    entityQuery<PartSearchResult>(
      'parts',
      defaultValues?.partId ?? '',
      'part',
      Boolean(defaultValues?.partId),
    ),
  )
  const selectedPart = pickedPart ?? (cleared ? null : (prefilledPart ?? null))

  const debouncedSearch = useDebouncedValue(partSearch)
  const { data: searchResults = [], isFetching: searching } = useQuery(
    itemTextSearchQuery<PartSearchResult>(
      { q: debouncedSearch, types: ['Part'], limit: 10 },
      debouncedSearch.length >= 2,
    ),
  )

  const { data: programs = [] } = useQuery(programListQuery())

  const form = useForm({
    defaultValues: {
      partId: defaultValues?.partId ?? (null as string | null),
      programId: defaultValues?.programId ?? '',
      quantity: defaultValues?.quantity ?? 1,
      priority: defaultValues?.priority ?? 'Normal',
      dueDate: defaultValues?.dueDate ?? '',
      customerOrder: defaultValues?.customerOrder ?? '',
      notes: defaultValues?.notes ?? '',
      assignedTo: defaultValues?.assignedTo ?? ([] as Array<string>),
      requiresSignOff: defaultValues?.requiresSignOff ?? false,
    },
    validators: {
      onSubmit: zodValidator(workOrderFormSchema),
    },
    onSubmit: async ({ value }) => {
      await onSubmit({
        partId: value.partId,
        // Empty means "derive it from the part" — the server does that, and
        // the validator above has already ruled out the part-less case.
        programId: value.programId || null,
        quantity: value.quantity,
        priority: value.priority,
        dueDate: value.dueDate || null,
        customerOrder: value.customerOrder || null,
        notes: value.notes || null,
        assignedTo: value.assignedTo,
        requiresSignOff: value.requiresSignOff,
      })
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-6"
    >
      {/* Part selection */}
      <div>
        <label className="text-sm font-medium text-slate-700 dark:text-slate-300 mb-1 block">
          Part
        </label>
        {selectedPart ? (
          <div className="flex items-center gap-2 p-3 bg-slate-50 dark:bg-slate-800 rounded border">
            <span className="font-medium">{selectedPart.itemNumber}</span>
            <span className="text-slate-500">{selectedPart.name}</span>
            <span className="text-xs text-slate-400">
              Rev {selectedPart.revision}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto"
              onClick={() => {
                setPickedPart(null)
                setCleared(true)
                form.setFieldValue('partId', null)
              }}
            >
              Change
            </Button>
          </div>
        ) : (
          <div className="relative">
            <Search className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <Input
              value={partSearch}
              onChange={(e) => setPartSearch(e.target.value)}
              placeholder="Search for a part..."
              className="pl-9"
            />
            {searching && (
              <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-slate-400" />
            )}
            {searchResults.length > 0 && (
              <div className="absolute z-10 w-full mt-1 bg-white dark:bg-slate-800 border rounded-lg shadow-lg max-h-48 overflow-auto">
                {searchResults.map((part) => (
                  <button
                    key={part.id}
                    type="button"
                    className="w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-sm"
                    onClick={() => {
                      setPickedPart(part)
                      setPartSearch('')
                      form.setFieldValue('partId', part.id)
                    }}
                  >
                    <span className="font-medium">{part.itemNumber}</span>
                    {part.name && (
                      <span className="text-slate-500 ml-2">{part.name}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Program — what the order is gated on once it exists */}
      <form.Field name="programId">
        {(field) => (
          <FormField
            label="Program"
            error={field.state.meta.errors[0]}
            helpText="Leave unset to inherit the program of the part being built"
          >
            <Select
              value={field.state.value || 'none'}
              onValueChange={(value) =>
                field.handleChange(value === 'none' ? '' : value)
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Select program" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Inherit from part</SelectItem>
                {programs.map((program) => (
                  <SelectItem key={program.id} value={program.id}>
                    {program.code} - {program.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        )}
      </form.Field>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Quantity */}
        <form.Field name="quantity">
          {(field) => (
            <FormField label="Quantity" error={field.state.meta.errors[0]}>
              <Input
                type="number"
                min={1}
                name={field.name}
                value={field.state.value}
                onChange={(e) =>
                  field.handleChange(parseInt(e.target.value) || 1)
                }
                onBlur={field.handleBlur}
              />
            </FormField>
          )}
        </form.Field>

        {/* Priority */}
        <form.Field name="priority">
          {(field) => (
            <FormField label="Priority" error={field.state.meta.errors[0]}>
              <Select
                value={field.state.value}
                onValueChange={(v) =>
                  field.handleChange(v as 'Low' | 'Normal' | 'High' | 'Urgent')
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Low">Low</SelectItem>
                  <SelectItem value="Normal">Normal</SelectItem>
                  <SelectItem value="High">High</SelectItem>
                  <SelectItem value="Urgent">Urgent</SelectItem>
                </SelectContent>
              </Select>
            </FormField>
          )}
        </form.Field>

        {/* Due Date */}
        <form.Field name="dueDate">
          {(field) => (
            <FormField label="Due Date" error={field.state.meta.errors[0]}>
              <Input
                type="date"
                name={field.name}
                value={field.state.value || ''}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
              />
            </FormField>
          )}
        </form.Field>

        {/* Customer Order */}
        <form.Field name="customerOrder">
          {(field) => (
            <FormField
              label="Customer Order"
              error={field.state.meta.errors[0]}
            >
              <Input
                name={field.name}
                value={field.state.value || ''}
                onChange={(e) => field.handleChange(e.target.value)}
                onBlur={field.handleBlur}
                placeholder="Optional reference number"
              />
            </FormField>
          )}
        </form.Field>
      </div>

      {/* Requires Sign-off */}
      <form.Field name="requiresSignOff">
        {(field) => (
          <div className="flex items-center gap-3 p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border">
            <input
              type="checkbox"
              id="requiresSignOff"
              checked={field.state.value}
              onChange={(e) => field.handleChange(e.target.checked)}
              className="h-5 w-5 rounded border-slate-300 dark:border-slate-700 text-sky-600 dark:text-sky-400 focus:ring-sky-500"
            />
            <div>
              <label
                htmlFor="requiresSignOff"
                className="text-sm font-medium text-slate-700 dark:text-slate-300"
              >
                Requires Sign-off
              </label>
              <p className="text-xs text-slate-500">
                Completed executions will require supervisor approval before
                being finalized
              </p>
            </div>
          </div>
        )}
      </form.Field>

      {/* Notes */}
      <form.Field name="notes">
        {(field) => (
          <FormField label="Notes" error={field.state.meta.errors[0]}>
            <Textarea
              name={field.name}
              value={field.state.value || ''}
              onChange={(e) => field.handleChange(e.target.value)}
              onBlur={field.handleBlur}
              placeholder="Additional notes or instructions..."
              rows={3}
            />
          </FormField>
        )}
      </form.Field>

      {/* Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        {onCancel && (
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? (
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
          ) : null}
          {defaultValues?.partId ? 'Update Work Order' : 'Create Work Order'}
        </Button>
      </div>
    </form>
  )
}
