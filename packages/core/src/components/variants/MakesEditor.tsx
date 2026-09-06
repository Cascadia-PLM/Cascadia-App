// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Plus, Trash2 } from 'lucide-react'
import type { Make, OptionModel } from '@/lib/types/variants'
import {
  Badge,
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

/**
 * The part's named makes: a code, a name, one selection per family, and an
 * active flag. Pure over `value`/`onChange`; the tab saves.
 */
export function MakesEditor({
  model,
  value,
  onChange,
  isEditing,
  onLoad,
}: {
  model: OptionModel
  value: Array<Make>
  onChange: (next: Array<Make>) => void
  isEditing: boolean
  /** Load a make's selections into the configurator, when one is mounted. */
  onLoad?: (make: Make) => void
}) {
  const update = (index: number, patch: Partial<Make>) =>
    onChange(value.map((m, i) => (i === index ? { ...m, ...patch } : m)))

  const setSelection = (index: number, family: string, code: string) => {
    const make = value[index]
    if (!make) return
    update(index, { selections: { ...make.selections, [family]: code } })
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold">Makes</h4>
        {isEditing && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([
                ...value,
                {
                  code: `MK${value.length + 1}`,
                  name: '',
                  selections: {},
                  active: true,
                },
              ])
            }
          >
            <Plus className="h-4 w-4 mr-1" />
            Make
          </Button>
        )}
      </div>
      {value.length === 0 && (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          No makes yet. A make is a named, complete set of selections; save one
          from the configurator or add one here.
        </p>
      )}
      {value.map((make, index) => (
        <div
          key={index}
          className="rounded-md border border-slate-200 dark:border-slate-800 p-3 grid grid-cols-[6rem_1fr_auto] gap-3 items-start"
        >
          <div className="space-y-2">
            {isEditing ? (
              <Input
                className="h-8 text-sm font-mono"
                value={make.code}
                onChange={(e) => update(index, { code: e.target.value })}
              />
            ) : (
              <Badge variant="default" className="font-mono">
                {make.code}
              </Badge>
            )}
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox
                checked={make.active}
                disabled={!isEditing}
                onCheckedChange={(checked) =>
                  update(index, { active: checked === true })
                }
              />
              Active
            </label>
          </div>
          <div className="space-y-2">
            {isEditing ? (
              <Input
                className="h-8 text-sm"
                placeholder="Name, e.g. Black"
                value={make.name}
                onChange={(e) => update(index, { name: e.target.value })}
              />
            ) : (
              <div className="text-sm">{make.name || '—'}</div>
            )}
            <div className="grid grid-cols-2 gap-2">
              {model.families.map((family) => (
                <div key={family.code} className="text-xs">
                  <div className="text-slate-500 dark:text-slate-400 mb-0.5">
                    {family.name}
                  </div>
                  {isEditing ? (
                    <Select
                      value={make.selections[family.code] ?? ''}
                      onValueChange={(v) => setSelection(index, family.code, v)}
                    >
                      <SelectTrigger className="h-8 text-sm">
                        <SelectValue placeholder="Select…" />
                      </SelectTrigger>
                      <SelectContent>
                        {family.values.map((v) => (
                          <SelectItem key={v.code} value={v.code}>
                            {v.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="text-sm">
                      {family.values.find(
                        (v) => v.code === make.selections[family.code],
                      )?.label ?? (
                        <span className="text-amber-600">not selected</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            {onLoad && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onLoad(make)}
              >
                Load
              </Button>
            )}
            {isEditing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 self-end"
                aria-label="Remove make"
                onClick={() => onChange(value.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
