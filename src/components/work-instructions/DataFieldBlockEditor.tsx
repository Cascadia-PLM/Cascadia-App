import { useEffect, useState } from 'react'
import { FormInput, Trash2 } from 'lucide-react'
import type { StepContentBlock } from '@/lib/items/types/work-instruction'
import { Button, Input } from '@/components/ui'

interface DataFieldBlockEditorProps {
  block: StepContentBlock
  onUpdate: (block: StepContentBlock) => void
  onDelete: () => void
}

export function DataFieldBlockEditor({
  block,
  onUpdate,
  onDelete,
}: DataFieldBlockEditorProps) {
  const [localLabel, setLocalLabel] = useState(block.fieldLabel || '')
  const labelTimeoutRef = useState<NodeJS.Timeout | undefined>(undefined)

  useEffect(() => {
    setLocalLabel(block.fieldLabel || '')
  }, [block.id])

  return (
    <div className="relative group border rounded-lg p-4 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-700">
      <div className="flex items-center gap-2 mb-3">
        <FormInput className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
          Data Collection Field
        </span>
      </div>

      <div className="space-y-3">
        {/* Field type */}
        <div>
          <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
            Field Type
          </label>
          <select
            className="w-full border rounded px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:border-slate-600"
            value={block.fieldType || 'text'}
            onChange={(e) =>
              onUpdate({
                ...block,
                fieldType: e.target.value as
                  | 'text'
                  | 'numeric'
                  | 'checkbox'
                  | 'passFail',
                fieldValidation:
                  e.target.value === 'numeric'
                    ? block.fieldValidation
                    : undefined,
              })
            }
          >
            <option value="text">Text</option>
            <option value="numeric">Numeric</option>
            <option value="checkbox">Checkbox</option>
            <option value="passFail">Pass / Fail</option>
          </select>
        </div>

        {/* Label */}
        <div>
          <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
            Label
          </label>
          <Input
            value={localLabel}
            onChange={(e) => {
              const val = e.target.value
              setLocalLabel(val)
              clearTimeout(labelTimeoutRef[0])
              const t = setTimeout(() => {
                onUpdate({ ...block, fieldLabel: val })
              }, 300)
              labelTimeoutRef[1](t)
            }}
            placeholder="e.g., Torque (ft-lbs)"
          />
        </div>

        {/* Required */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`required-${block.id}`}
            checked={block.fieldRequired || false}
            onChange={(e) =>
              onUpdate({ ...block, fieldRequired: e.target.checked })
            }
            className="rounded border-slate-300"
          />
          <label
            htmlFor={`required-${block.id}`}
            className="text-sm text-slate-700 dark:text-slate-300"
          >
            Required field
          </label>
        </div>

        {/* Numeric validation */}
        {block.fieldType === 'numeric' && (
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
                Min Value
              </label>
              <Input
                type="number"
                value={block.fieldValidation?.min ?? ''}
                onChange={(e) =>
                  onUpdate({
                    ...block,
                    fieldValidation: {
                      ...block.fieldValidation,
                      min: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
                placeholder="No minimum"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
                Max Value
              </label>
              <Input
                type="number"
                value={block.fieldValidation?.max ?? ''}
                onChange={(e) =>
                  onUpdate({
                    ...block,
                    fieldValidation: {
                      ...block.fieldValidation,
                      max: e.target.value ? Number(e.target.value) : undefined,
                    },
                  })
                }
                placeholder="No maximum"
              />
            </div>
          </div>
        )}

        {/* Preview */}
        <div className="mt-2 p-3 bg-white dark:bg-slate-800 rounded border">
          <span className="text-xs text-slate-500 block mb-1">Preview</span>
          <DataFieldPreview block={block} />
        </div>
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4 text-red-500" />
      </Button>
    </div>
  )
}

function DataFieldPreview({ block }: { block: StepContentBlock }) {
  const label = block.fieldLabel || 'Untitled Field'

  switch (block.fieldType) {
    case 'numeric':
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
            {label}:
          </span>
          <div className="px-3 py-1 border rounded bg-slate-50 dark:bg-slate-700 text-sm text-slate-400 min-w-[100px]">
            {block.fieldValidation?.min != null &&
            block.fieldValidation?.max != null
              ? `${block.fieldValidation.min} – ${block.fieldValidation.max}`
              : '0.00'}
          </div>
        </div>
      )
    case 'checkbox':
      return (
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            disabled
            className="rounded border-slate-300"
          />
          <span className="text-sm text-emerald-700 dark:text-emerald-300">
            {label}
          </span>
        </div>
      )
    case 'passFail':
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
            {label}:
          </span>
          <div className="flex gap-1">
            <span className="px-2 py-0.5 text-xs font-medium rounded bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
              Pass
            </span>
            <span className="px-2 py-0.5 text-xs font-medium rounded bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300">
              Fail
            </span>
          </div>
        </div>
      )
    default:
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
            {label}:
          </span>
          <div className="px-3 py-1 border rounded bg-slate-50 dark:bg-slate-700 text-sm text-slate-400 min-w-[100px]">
            Enter text...
          </div>
        </div>
      )
  }
}
