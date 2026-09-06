// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Plus, Trash2 } from 'lucide-react'
import { ConditionPicker } from './ConditionPicker'
import type {
  OptionCondition,
  OptionFamily,
  OptionModel,
} from '@/lib/types/variants'
import { Badge, Button, Checkbox, Input, Label } from '@/components/ui'
import { OPTION_CODE_PATTERN } from '@/lib/types/variants'

/**
 * Edit a part's option model in place: families with their values, and the
 * constraints between them. Pure over `value`/`onChange`; the tab that mounts
 * it owns saving. Read-only when not editing, like every field card.
 */
export function OptionModelEditor({
  value,
  onChange,
  isEditing,
}: {
  value: OptionModel
  onChange: (next: OptionModel) => void
  isEditing: boolean
}) {
  const setFamilies = (families: Array<OptionFamily>) =>
    onChange({ ...value, families })

  const updateFamily = (index: number, patch: Partial<OptionFamily>) =>
    setFamilies(
      value.families.map((f, i) => (i === index ? { ...f, ...patch } : f)),
    )

  const addFamily = () =>
    setFamilies([
      ...value.families,
      { code: '', name: '', required: true, values: [] },
    ])

  const removeFamily = (index: number) =>
    setFamilies(value.families.filter((_, i) => i !== index))

  const addValue = (index: number, label: string) => {
    const family = value.families[index]
    if (!family || !label.trim()) return
    const code = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
    if (family.values.some((v) => v.code === code)) return
    updateFamily(index, {
      values: [...family.values, { code, label: label.trim() }],
    })
  }

  const removeValue = (index: number, code: string) => {
    const family = value.families[index]
    if (!family) return
    updateFamily(index, {
      values: family.values.filter((v) => v.code !== code),
    })
  }

  const setConstraint = (
    index: number,
    patch: Partial<OptionModel['constraints'][number]>,
  ) =>
    onChange({
      ...value,
      constraints: value.constraints.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    })

  const emptyCondition: OptionCondition = { all: [] }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Option families</h4>
          {isEditing && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addFamily}
            >
              <Plus className="h-4 w-4 mr-1" />
              Family
            </Button>
          )}
        </div>
        {value.families.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No option families. Add one here, or from the option icon on a BOM
            line.
          </p>
        )}
        {value.families.map((family, index) => {
          const codeInvalid =
            family.code !== '' && !OPTION_CODE_PATTERN.test(family.code)
          return (
            <div
              key={index}
              className="rounded-md border border-slate-200 dark:border-slate-800 p-3 space-y-2"
            >
              <div className="grid grid-cols-[1fr_2fr_auto_auto] gap-2 items-end">
                <div>
                  <Label className="text-xs">Code</Label>
                  {isEditing ? (
                    <Input
                      className={`h-8 text-sm font-mono ${codeInvalid ? 'border-red-500' : ''}`}
                      value={family.code}
                      placeholder="color"
                      onChange={(e) =>
                        updateFamily(index, {
                          code: e.target.value.toLowerCase(),
                        })
                      }
                    />
                  ) : (
                    <div className="font-mono text-sm">{family.code}</div>
                  )}
                </div>
                <div>
                  <Label className="text-xs">Name</Label>
                  {isEditing ? (
                    <Input
                      className="h-8 text-sm"
                      value={family.name}
                      placeholder="Colour"
                      onChange={(e) =>
                        updateFamily(index, { name: e.target.value })
                      }
                    />
                  ) : (
                    <div className="text-sm">{family.name}</div>
                  )}
                </div>
                <label className="flex items-center gap-1.5 text-xs pb-2">
                  <Checkbox
                    checked={family.required}
                    disabled={!isEditing}
                    onCheckedChange={(checked) =>
                      updateFamily(index, { required: checked === true })
                    }
                  />
                  Required
                </label>
                {isEditing && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 w-8 p-0"
                    aria-label="Remove family"
                    onClick={() => removeFamily(index)}
                  >
                    <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {family.values.map((v) => (
                  <Badge key={v.code} variant="secondary" className="gap-1">
                    {v.label}
                    <span className="font-mono text-[10px] opacity-60">
                      {v.code}
                    </span>
                    {isEditing && (
                      <button
                        type="button"
                        className="ml-0.5 opacity-60 hover:opacity-100"
                        aria-label={`Remove ${v.label}`}
                        onClick={() => removeValue(index, v.code)}
                      >
                        ×
                      </button>
                    )}
                  </Badge>
                ))}
                {isEditing && (
                  <Input
                    className="h-7 w-40 text-xs"
                    placeholder="Add value, press Enter"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addValue(index, e.currentTarget.value)
                        e.currentTarget.value = ''
                      }
                    }}
                  />
                )}
              </div>
            </div>
          )
        })}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-semibold">Constraints</h4>
          {isEditing && value.families.length > 0 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                onChange({
                  ...value,
                  constraints: [
                    ...value.constraints,
                    {
                      when: emptyCondition,
                      require: emptyCondition,
                      message: '',
                    },
                  ],
                })
              }
            >
              <Plus className="h-4 w-4 mr-1" />
              Constraint
            </Button>
          )}
        </div>
        {value.constraints.length === 0 && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No constraints. A constraint says: when these selections are made,
            these others are required.
          </p>
        )}
        {value.constraints.map((constraint, index) => (
          <div
            key={index}
            className="rounded-md border border-slate-200 dark:border-slate-800 p-3 space-y-3"
          >
            <div className="grid grid-cols-2 gap-4">
              <div>
                <div className="text-xs font-medium mb-1">When</div>
                <ConditionPicker
                  model={value}
                  value={constraint.when.all.length ? constraint.when : null}
                  disabled={!isEditing}
                  onChange={(next) =>
                    setConstraint(index, { when: next ?? emptyCondition })
                  }
                />
              </div>
              <div>
                <div className="text-xs font-medium mb-1">Require</div>
                <ConditionPicker
                  model={value}
                  value={
                    constraint.require.all.length ? constraint.require : null
                  }
                  disabled={!isEditing}
                  onChange={(next) =>
                    setConstraint(index, { require: next ?? emptyCondition })
                  }
                />
              </div>
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label className="text-xs">Message</Label>
                {isEditing ? (
                  <Input
                    className="h-8 text-sm"
                    value={constraint.message}
                    placeholder="Without a display only 2 or 3 buttons fit"
                    onChange={(e) =>
                      setConstraint(index, { message: e.target.value })
                    }
                  />
                ) : (
                  <div className="text-sm">{constraint.message || '—'}</div>
                )}
              </div>
              {isEditing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-8 p-0"
                  aria-label="Remove constraint"
                  onClick={() =>
                    onChange({
                      ...value,
                      constraints: value.constraints.filter(
                        (_, i) => i !== index,
                      ),
                    })
                  }
                >
                  <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </section>
    </div>
  )
}
