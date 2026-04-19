import { useEffect, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { Loader2, Search } from 'lucide-react'
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

interface PartSearchResult {
  id: string
  itemNumber: string
  name?: string
  revision: string
}

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
  const [searchResults, setSearchResults] = useState<Array<PartSearchResult>>(
    [],
  )
  const [searching, setSearching] = useState(false)
  const [selectedPart, setSelectedPart] = useState<PartSearchResult | null>(
    null,
  )

  // Load part if defaultValues has partId
  useEffect(() => {
    if (defaultValues?.partId && !selectedPart) {
      fetch(`/api/parts/${defaultValues.partId}`)
        .then((r) => r.json())
        .then((data) => {
          const part = data.data?.part || data.data
          if (part) {
            setSelectedPart({
              id: part.id,
              itemNumber: part.itemNumber,
              name: part.name,
              revision: part.revision,
            })
          }
        })
        .catch(() => {})
    }
  }, [defaultValues?.partId])

  // Part search
  useEffect(() => {
    if (partSearch.length < 2) {
      setSearchResults([])
      return
    }
    const timeout = setTimeout(async () => {
      setSearching(true)
      try {
        const response = await fetch(
          `/api/items/search?q=${encodeURIComponent(partSearch)}&type=Part&limit=10`,
        )
        const data = await response.json()
        setSearchResults(
          (data.data?.items || []).map((item: Record<string, unknown>) => ({
            id: item.id,
            itemNumber: item.itemNumber,
            name: item.name,
            revision: item.revision,
          })),
        )
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 300)
    return () => clearTimeout(timeout)
  }, [partSearch])

  const form = useForm({
    defaultValues: {
      partId: defaultValues?.partId ?? (null as string | null),
      quantity: defaultValues?.quantity ?? 1,
      priority:
        defaultValues?.priority ??
        ('Normal' as 'Low' | 'Normal' | 'High' | 'Urgent'),
      dueDate: defaultValues?.dueDate ?? ('' as string),
      customerOrder: defaultValues?.customerOrder ?? '',
      notes: defaultValues?.notes ?? '',
      assignedTo: defaultValues?.assignedTo ?? ([] as Array<string>),
      requiresSignOff:
        ((defaultValues as Record<string, unknown>)
          ?.requiresSignOff as boolean) ?? false,
    },
    onSubmit: async ({ value }) => {
      await onSubmit({
        partId: value.partId,
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
                setSelectedPart(null)
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
                      setSelectedPart(part)
                      setPartSearch('')
                      setSearchResults([])
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Quantity */}
        <form.Field name="quantity">
          {(field) => (
            <FormField
              label="Quantity"
              error={field.state.meta.errors[0] as string | undefined}
            >
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
            <FormField
              label="Priority"
              error={field.state.meta.errors[0] as string | undefined}
            >
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
            <FormField
              label="Due Date"
              error={field.state.meta.errors[0] as string | undefined}
            >
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
              error={field.state.meta.errors[0] as string | undefined}
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
              className="h-5 w-5 rounded border-slate-300 text-sky-600 focus:ring-sky-500"
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
          <FormField
            label="Notes"
            error={field.state.meta.errors[0] as string | undefined}
          >
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
