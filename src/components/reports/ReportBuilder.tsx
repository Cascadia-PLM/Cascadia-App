import { useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react'
import type {
  FieldDefinition,
  ReportColumn,
  ReportCreateInput,
  ReportFilter,
  ReportSort,
} from '@/lib/reports/types'
import { filterOperators, formatTypes, reportSchema } from '@/lib/reports/types'
import {
  Button,
  Card,
  FormField,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'

interface ReportBuilderProps {
  initialData?: Partial<ReportCreateInput>
  onSubmit: (data: ReportCreateInput) => void | Promise<void>
  onCancel?: () => void
  isSubmitting?: boolean
}

// Available item types
const itemTypes = [
  { value: 'Part', label: 'Part' },
  { value: 'Document', label: 'Document' },
  { value: 'ChangeOrder', label: 'Change Order' },
  { value: 'Requirement', label: 'Requirement' },
  { value: 'Task', label: 'Task' },
  { value: 'TestPlan', label: 'Test Plan' },
  { value: 'TestCase', label: 'Test Case' },
  { value: 'Issue', label: 'Issue' },
]

// Operator labels for display
const operatorLabels: Record<string, string> = {
  eq: 'Equals',
  ne: 'Not Equals',
  gt: 'Greater Than',
  lt: 'Less Than',
  gte: 'Greater Than or Equal',
  lte: 'Less Than or Equal',
  like: 'Contains',
  not_like: 'Does Not Contain',
  in: 'In List',
  not_in: 'Not In List',
  is_null: 'Is Empty',
  is_not_null: 'Is Not Empty',
  starts_with: 'Starts With',
  ends_with: 'Ends With',
  between: 'Between',
}

// Get available fields based on item type
function getAvailableFields(itemType: string): Array<FieldDefinition> {
  const baseFields: Array<FieldDefinition> = [
    { path: 'itemNumber', label: 'Item Number', type: 'string' },
    { path: 'revision', label: 'Revision', type: 'string' },
    { path: 'name', label: 'Name', type: 'string' },
    { path: 'state', label: 'State', type: 'string' },
    { path: 'createdAt', label: 'Created At', type: 'datetime' },
    { path: 'modifiedAt', label: 'Modified At', type: 'datetime' },
  ]

  const typeSpecificFields: Record<string, Array<FieldDefinition>> = {
    Part: [
      {
        path: 'parts.description',
        label: 'Description',
        type: 'string',
        table: 'parts',
      },
      {
        path: 'parts.partType',
        label: 'Type',
        type: 'string',
        table: 'parts',
      },
      {
        path: 'parts.material',
        label: 'Material',
        type: 'string',
        table: 'parts',
      },
      { path: 'parts.weight', label: 'Weight', type: 'number', table: 'parts' },
      { path: 'parts.cost', label: 'Cost', type: 'number', table: 'parts' },
      {
        path: 'parts.leadTimeDays',
        label: 'Lead Time (Days)',
        type: 'number',
        table: 'parts',
      },
      {
        path: 'parts.quantityOnHand',
        label: 'Quantity On Hand',
        type: 'number',
        table: 'parts',
      },
      {
        path: 'parts.location',
        label: 'Location',
        type: 'string',
        table: 'parts',
      },
    ],
    Document: [
      {
        path: 'documents.description',
        label: 'Description',
        type: 'string',
        table: 'documents',
      },
      {
        path: 'documents.fileName',
        label: 'File Name',
        type: 'string',
        table: 'documents',
      },
      {
        path: 'documents.fileSize',
        label: 'File Size',
        type: 'number',
        table: 'documents',
      },
      {
        path: 'documents.mimeType',
        label: 'MIME Type',
        type: 'string',
        table: 'documents',
      },
    ],
    ChangeOrder: [
      {
        path: 'change_orders.changeType',
        label: 'Change Type',
        type: 'string',
        table: 'change_orders',
      },
      {
        path: 'change_orders.priority',
        label: 'Priority',
        type: 'string',
        table: 'change_orders',
      },
      {
        path: 'change_orders.reasonForChange',
        label: 'Reason for Change',
        type: 'string',
        table: 'change_orders',
      },
      {
        path: 'change_orders.riskLevel',
        label: 'Risk Level',
        type: 'string',
        table: 'change_orders',
      },
    ],
    Requirement: [
      {
        path: 'requirements.description',
        label: 'Description',
        type: 'string',
        table: 'requirements',
      },
      {
        path: 'requirements.type',
        label: 'Type',
        type: 'string',
        table: 'requirements',
      },
      {
        path: 'requirements.priority',
        label: 'Priority',
        type: 'string',
        table: 'requirements',
      },
      {
        path: 'requirements.status',
        label: 'Status',
        type: 'string',
        table: 'requirements',
      },
      {
        path: 'requirements.category',
        label: 'Category',
        type: 'string',
        table: 'requirements',
      },
    ],
    Task: [
      {
        path: 'tasks.description',
        label: 'Description',
        type: 'string',
        table: 'tasks',
      },
      {
        path: 'tasks.priority',
        label: 'Priority',
        type: 'string',
        table: 'tasks',
      },
      {
        path: 'tasks.dueDate',
        label: 'Due Date',
        type: 'date',
        table: 'tasks',
      },
      {
        path: 'tasks.estimatedHours',
        label: 'Estimated Hours',
        type: 'number',
        table: 'tasks',
      },
      {
        path: 'tasks.actualHours',
        label: 'Actual Hours',
        type: 'number',
        table: 'tasks',
      },
    ],
  }

  return [...baseFields, ...(typeSpecificFields[itemType] ?? [])]
}

// Use the imported types from reports/types.ts, with local simplified versions for form manipulation
type LocalReportColumn = {
  fieldPath: string
  label: string
  displayOrder: number
  isVisible: boolean
  formatType?: string
}

type LocalReportFilter = {
  fieldPath: string
  operator: string
  value?: string
  value2?: string
  displayOrder?: number
}

type LocalReportSort = {
  fieldPath: string
  direction: 'asc' | 'desc'
  priority: number
}

export function ReportBuilder({
  initialData,
  onSubmit,
  onCancel,
  isSubmitting,
}: ReportBuilderProps) {
  const [selectedItemType, setSelectedItemType] = useState(
    initialData?.itemType || 'Part',
  )

  const form = useForm({
    defaultValues: {
      name: initialData?.name ?? '',
      description: initialData?.description ?? '',
      itemType: initialData?.itemType ?? 'Part',
      isPublic: initialData?.isPublic ?? false,
      columns: (initialData?.columns ?? [
        {
          fieldPath: 'itemNumber',
          label: 'Item Number',
          displayOrder: 0,
          isVisible: true,
        },
      ]) as Array<ReportColumn>,
      filters: (initialData?.filters ?? []) as Array<ReportFilter>,
      sorts: (initialData?.sorts ?? []) as Array<ReportSort>,
    },
    onSubmit: async ({ value }) => {
      // Validate with Zod and then submit
      const result = reportSchema.safeParse(value)
      if (result.success) {
        await onSubmit(result.data)
      }
    },
  })

  const availableFields = getAvailableFields(selectedItemType)

  // Column management
  const addColumn = () => {
    const columns = form.getFieldValue('columns')
    const newColumn: LocalReportColumn = {
      fieldPath: 'itemNumber',
      label: 'Item Number',
      displayOrder: columns.length,
      isVisible: true,
    }
    form.setFieldValue('columns', [
      ...columns,
      newColumn,
    ] as ReportCreateInput['columns'])
  }

  const removeColumn = (index: number) => {
    const columns = form.getFieldValue('columns')
    const updated = columns
      .filter((_, i) => i !== index)
      .map((col, i) => ({ ...col, displayOrder: i }))
    form.setFieldValue('columns', updated as ReportCreateInput['columns'])
  }

  const moveColumn = (index: number, direction: 'up' | 'down') => {
    const columns = form.getFieldValue('columns')
    const newColumns = [...columns]
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= columns.length) return

    const temp = newColumns[index]
    newColumns[index] = newColumns[newIndex]
    newColumns[newIndex] = temp

    form.setFieldValue(
      'columns',
      newColumns.map((col, i) => ({
        ...col,
        displayOrder: i,
      })) as ReportCreateInput['columns'],
    )
  }

  const updateColumn = (index: number, field: string, value: string) => {
    const columns = form.getFieldValue('columns')
    const updated = [...columns]
    if (field === 'fieldPath') {
      const fieldDef = availableFields.find((f) => f.path === value)
      updated[index] = {
        ...updated[index],
        fieldPath: value,
        label: fieldDef?.label || value,
      }
    } else {
      updated[index] = { ...updated[index], [field]: value }
    }
    form.setFieldValue('columns', updated as ReportCreateInput['columns'])
  }

  // Filter management
  const addFilter = () => {
    const filters = form.getFieldValue('filters')
    const newFilter: LocalReportFilter = {
      fieldPath: 'itemNumber',
      operator: 'eq',
      value: '',
      displayOrder: filters.length,
    }
    form.setFieldValue('filters', [
      ...filters,
      newFilter,
    ] as ReportCreateInput['filters'])
  }

  const removeFilter = (index: number) => {
    const filters = form.getFieldValue('filters')
    const updated = filters
      .filter((_, i) => i !== index)
      .map((f, i) => ({ ...f, displayOrder: i }))
    form.setFieldValue('filters', updated as ReportCreateInput['filters'])
  }

  const updateFilter = (index: number, field: string, value: string) => {
    const filters = form.getFieldValue('filters')
    const updated = [...filters]
    updated[index] = { ...updated[index], [field]: value }
    form.setFieldValue('filters', updated as ReportCreateInput['filters'])
  }

  // Sort management
  const addSort = () => {
    const sorts = form.getFieldValue('sorts')
    const newSort: LocalReportSort = {
      fieldPath: 'itemNumber',
      direction: 'asc',
      priority: sorts.length,
    }
    form.setFieldValue('sorts', [
      ...sorts,
      newSort,
    ] as ReportCreateInput['sorts'])
  }

  const removeSort = (index: number) => {
    const sorts = form.getFieldValue('sorts')
    const updated = sorts
      .filter((_, i) => i !== index)
      .map((s, i) => ({ ...s, priority: i }))
    form.setFieldValue('sorts', updated as ReportCreateInput['sorts'])
  }

  const updateSort = (index: number, field: string, value: string) => {
    const sorts = form.getFieldValue('sorts')
    const updated = [...sorts]
    updated[index] = { ...updated[index], [field]: value }
    form.setFieldValue('sorts', updated as ReportCreateInput['sorts'])
  }

  const handleItemTypeChange = (value: string) => {
    setSelectedItemType(value)
    form.setFieldValue('itemType', value)
    form.setFieldValue('columns', [
      {
        fieldPath: 'itemNumber',
        label: 'Item Number',
        displayOrder: 0,
        isVisible: true,
      },
    ] as ReportCreateInput['columns'])
    form.setFieldValue('filters', [] as ReportCreateInput['filters'])
    form.setFieldValue('sorts', [] as ReportCreateInput['sorts'])
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        e.stopPropagation()
        form.handleSubmit()
      }}
      className="space-y-8"
    >
      {/* Report Information Section */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold mb-4">Report Information</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <form.Field name="name">
            {(field) => (
              <FormField
                label="Report Name"
                required
                error={field.state.meta.errors[0] as string | undefined}
              >
                <Input
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="My Report"
                  error={field.state.meta.errors.length > 0}
                />
              </FormField>
            )}
          </form.Field>

          <form.Field name="itemType">
            {(field) => (
              <FormField
                label="Item Type"
                required
                error={field.state.meta.errors[0] as string | undefined}
              >
                <Select
                  value={selectedItemType}
                  onValueChange={handleItemTypeChange}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select item type" />
                  </SelectTrigger>
                  <SelectContent>
                    {itemTypes.map((type) => (
                      <SelectItem key={type.value} value={type.value}>
                        {type.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
            )}
          </form.Field>

          <form.Field name="description">
            {(field) => (
              <FormField
                label="Description"
                error={field.state.meta.errors[0] as string | undefined}
                className="md:col-span-2"
              >
                <Textarea
                  name={field.name}
                  value={field.state.value}
                  onChange={(e) => field.handleChange(e.target.value)}
                  onBlur={field.handleBlur}
                  placeholder="Optional description of this report..."
                  rows={3}
                />
              </FormField>
            )}
          </form.Field>

          <form.Field name="isPublic">
            {(field) => (
              <FormField label="Visibility">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={field.state.value}
                    onChange={(e) => field.handleChange(e.target.checked)}
                    className="w-4 h-4 rounded border-gray-300"
                  />
                  <span className="text-sm">Make this report public</span>
                </label>
              </FormField>
            )}
          </form.Field>
        </div>
      </Card>

      {/* Columns Section */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Columns</h3>
          <Button type="button" variant="outline" size="sm" onClick={addColumn}>
            <Plus className="w-4 h-4 mr-1" />
            Add Column
          </Button>
        </div>

        <form.Field name="columns">
          {(field) => (
            <>
              {field.state.meta.errors.length > 0 && (
                <p className="text-sm text-red-500 mb-4">
                  {String(field.state.meta.errors[0])}
                </p>
              )}

              <div className="space-y-3">
                {field.state.value.map(
                  (column: ReportColumn, index: number) => (
                    <div
                      key={index}
                      className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                    >
                      <div className="flex flex-col gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => moveColumn(index, 'up')}
                          disabled={index === 0}
                          className="h-6 w-6 p-0"
                        >
                          <ChevronUp className="w-4 h-4" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => moveColumn(index, 'down')}
                          disabled={index === field.state.value.length - 1}
                          className="h-6 w-6 p-0"
                        >
                          <ChevronDown className="w-4 h-4" />
                        </Button>
                      </div>

                      <Select
                        value={column.fieldPath}
                        onValueChange={(value) =>
                          updateColumn(index, 'fieldPath', value)
                        }
                      >
                        <SelectTrigger className="w-48">
                          <SelectValue placeholder="Select field" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableFields.map((f) => (
                            <SelectItem key={f.path} value={f.path}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Input
                        value={column.label}
                        onChange={(e) =>
                          updateColumn(index, 'label', e.target.value)
                        }
                        placeholder="Column Label"
                        className="flex-1"
                      />

                      <Select
                        value={column.formatType || 'text'}
                        onValueChange={(value) =>
                          updateColumn(index, 'formatType', value)
                        }
                      >
                        <SelectTrigger className="w-32">
                          <SelectValue placeholder="Format" />
                        </SelectTrigger>
                        <SelectContent>
                          {formatTypes.map((format) => (
                            <SelectItem key={format} value={format}>
                              {format.charAt(0).toUpperCase() + format.slice(1)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeColumn(index)}
                        disabled={field.state.value.length === 1}
                        className="text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ),
                )}
              </div>
            </>
          )}
        </form.Field>
      </Card>

      {/* Filters Section */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Filters (Optional)</h3>
          <Button type="button" variant="outline" size="sm" onClick={addFilter}>
            <Plus className="w-4 h-4 mr-1" />
            Add Filter
          </Button>
        </div>

        <form.Field name="filters">
          {(field) => (
            <>
              {field.state.value.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No filters configured. All matching items will be included.
                </p>
              ) : (
                <div className="space-y-3">
                  {field.state.value.map(
                    (filter: ReportFilter, index: number) => (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                      >
                        <Select
                          value={filter.fieldPath}
                          onValueChange={(value) =>
                            updateFilter(index, 'fieldPath', value)
                          }
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Select field" />
                          </SelectTrigger>
                          <SelectContent>
                            {availableFields.map((f) => (
                              <SelectItem key={f.path} value={f.path}>
                                {f.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        <Select
                          value={filter.operator}
                          onValueChange={(value) =>
                            updateFilter(index, 'operator', value)
                          }
                        >
                          <SelectTrigger className="w-48">
                            <SelectValue placeholder="Operator" />
                          </SelectTrigger>
                          <SelectContent>
                            {filterOperators.map((op) => (
                              <SelectItem key={op} value={op}>
                                {operatorLabels[op]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>

                        {!['is_null', 'is_not_null'].includes(
                          filter.operator,
                        ) && (
                          <Input
                            value={filter.value || ''}
                            onChange={(e) =>
                              updateFilter(index, 'value', e.target.value)
                            }
                            placeholder="Value"
                            className="flex-1"
                          />
                        )}

                        {filter.operator === 'between' && (
                          <Input
                            value={filter.value2 || ''}
                            onChange={(e) =>
                              updateFilter(index, 'value2', e.target.value)
                            }
                            placeholder="End Value"
                            className="flex-1"
                          />
                        )}

                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeFilter(index)}
                          className="text-red-500 hover:text-red-700"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    ),
                  )}
                </div>
              )}
            </>
          )}
        </form.Field>
      </Card>

      {/* Sorting Section */}
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">Sorting (Optional)</h3>
          <Button type="button" variant="outline" size="sm" onClick={addSort}>
            <Plus className="w-4 h-4 mr-1" />
            Add Sort
          </Button>
        </div>

        <form.Field name="sorts">
          {(field) => (
            <>
              {field.state.value.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No sorting configured. Results will be sorted by Modified At
                  descending.
                </p>
              ) : (
                <div className="space-y-3">
                  {field.state.value.map((sort: ReportSort, index: number) => (
                    <div
                      key={index}
                      className="flex items-center gap-3 p-3 bg-gray-50 dark:bg-gray-800 rounded-lg"
                    >
                      <span className="text-sm font-medium text-gray-500 w-8">
                        #{index + 1}
                      </span>

                      <Select
                        value={sort.fieldPath}
                        onValueChange={(value) =>
                          updateSort(index, 'fieldPath', value)
                        }
                      >
                        <SelectTrigger className="w-48">
                          <SelectValue placeholder="Select field" />
                        </SelectTrigger>
                        <SelectContent>
                          {availableFields.map((f) => (
                            <SelectItem key={f.path} value={f.path}>
                              {f.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>

                      <Select
                        value={sort.direction}
                        onValueChange={(value) =>
                          updateSort(index, 'direction', value)
                        }
                      >
                        <SelectTrigger className="w-40">
                          <SelectValue placeholder="Direction" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="asc">Ascending</SelectItem>
                          <SelectItem value="desc">Descending</SelectItem>
                        </SelectContent>
                      </Select>

                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeSort(index)}
                        className="text-red-500 hover:text-red-700"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </form.Field>
      </Card>

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-4 border-t">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting
            ? 'Saving...'
            : initialData?.name
              ? 'Update Report'
              : 'Create Report'}
        </Button>
      </div>
    </form>
  )
}
