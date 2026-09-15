// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { OptionCondition, OptionModel } from '@/lib/types/variants'
import { Checkbox } from '@/components/ui'

/**
 * Build an option condition by ticking values, one section per family.
 * Ticked values within a family OR together; families with any tick AND
 * together; a family with no tick is left out of the condition. No ticks at
 * all is a fixed line (`null`).
 *
 * Shared by the BOM line popover and the constraint editor so the two never
 * disagree about what a condition can say.
 */
export function ConditionPicker({
  model,
  value,
  onChange,
  disabled,
}: {
  model: OptionModel
  value: OptionCondition | null
  onChange: (next: OptionCondition | null) => void
  disabled?: boolean
}) {
  const isTicked = (family: string, code: string) =>
    value?.all.some((e) => e.family === family && e.values.includes(code)) ??
    false

  const toggle = (family: string, code: string) => {
    const entries = (value?.all ?? []).map((e) => ({
      family: e.family,
      values: [...e.values],
    }))
    const entry = entries.find((e) => e.family === family)
    if (entry) {
      entry.values = entry.values.includes(code)
        ? entry.values.filter((v) => v !== code)
        : [...entry.values, code]
    } else {
      entries.push({ family, values: [code] })
    }
    const kept = entries.filter((e) => e.values.length > 0)
    onChange(kept.length > 0 ? { all: kept } : null)
  }

  if (model.families.length === 0) {
    return (
      <p className="text-xs text-slate-500 dark:text-slate-400">
        No option families declared yet.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      {model.families.map((family) => (
        <div key={family.code}>
          <div className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1">
            {family.name}
            <span className="ml-1 font-mono text-slate-400">{family.code}</span>
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {family.values.map((v) => (
              <label
                key={v.code}
                className="flex items-center gap-1.5 text-sm cursor-pointer"
              >
                <Checkbox
                  checked={isTicked(family.code, v.code)}
                  disabled={disabled}
                  onCheckedChange={() => toggle(family.code, v.code)}
                />
                <span>{v.label}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
