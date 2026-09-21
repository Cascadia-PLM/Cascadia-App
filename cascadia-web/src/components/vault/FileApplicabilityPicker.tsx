// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { SlidersHorizontal, Trash2 } from 'lucide-react'
import {
  conditionFromSelections,
  normalizeOptionApplicability,
  optionConditionKey,
} from '@cascadia/commons/types/variants'
import type {
  Make,
  OptionApplicability,
  OptionCondition,
  OptionModel,
} from '@cascadia/commons/types/variants'
import { ConditionPicker } from '@/components/variants/ConditionPicker'
import { OptionConditionChips } from '@/components/variants/OptionConditionChips'
import {
  Button,
  Checkbox,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui'
import { cn } from '@/utils'

function exactCondition(make: Make): OptionCondition {
  return conditionFromSelections(make.selections)
}

/**
 * Edits the applicability carried by one vault file. Named executions are
 * shortcuts: storage remains option-based, so a later execution with the
 * same selections receives the file without another attachment edit.
 */
export function FileApplicabilityPicker({
  model,
  makes = [],
  value,
  onChange,
  disabled,
  compact = false,
}: {
  model: OptionModel
  makes?: Array<Make>
  value: OptionApplicability | null | undefined
  onChange: (next: OptionApplicability | null) => void
  disabled?: boolean
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<OptionApplicability | null>(value ?? null)
  const [custom, setCustom] = useState<OptionCondition | null>(null)
  const activeMakes = makes.filter(
    (make) => make.active && Object.keys(make.selections).length > 0,
  )

  const hasCondition = (condition: OptionCondition) => {
    const key = optionConditionKey(condition)
    return (
      draft?.any.some((entry) => optionConditionKey(entry) === key) ?? false
    )
  }

  const toggleCondition = (condition: OptionCondition) => {
    const key = optionConditionKey(condition)
    const current = draft?.any ?? []
    const next = current.some((entry) => optionConditionKey(entry) === key)
      ? current.filter((entry) => optionConditionKey(entry) !== key)
      : [...current, condition]
    setDraft(
      next.length > 0 ? normalizeOptionApplicability({ any: next }) : null,
    )
  }

  const removeAt = (index: number) => {
    const next = (draft?.any ?? []).filter((_, i) => i !== index)
    setDraft(next.length > 0 ? { any: next } : null)
  }

  const save = () => {
    onChange(draft ? normalizeOptionApplicability(draft) : null)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setDraft(value ?? null)
          setCustom(null)
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={compact ? 'ghost' : 'outline'}
          size="sm"
          disabled={disabled}
          className={cn(compact && 'h-8 px-2')}
          title="File applicability"
        >
          <SlidersHorizontal className="h-4 w-4" />
          {!compact && (
            <span className="ml-2">
              {value
                ? `${value.any.length} applicability rule${value.any.length === 1 ? '' : 's'}`
                : 'All executions'}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[26rem] max-w-[calc(100vw-2rem)]"
      >
        <div className="space-y-4">
          <div>
            <div className="text-sm font-medium">File applicability</div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Common files are used by every execution. Otherwise the file is
              used when any rule below matches the selected options.
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Checkbox checked={!draft} onCheckedChange={() => setDraft(null)} />
            Common to all executions
          </label>

          {activeMakes.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Execution shortcuts
              </div>
              <div className="grid grid-cols-2 gap-2">
                {activeMakes.map((make) => {
                  const condition = exactCondition(make)
                  return (
                    <label
                      key={make.code}
                      className="flex items-start gap-2 rounded-md border border-slate-200 dark:border-slate-800 p-2 text-sm cursor-pointer"
                    >
                      <Checkbox
                        checked={hasCondition(condition)}
                        onCheckedChange={() => toggleCondition(condition)}
                      />
                      <span className="min-w-0">
                        <span className="font-mono">{make.code}</span>
                        {make.name && (
                          <span className="block truncate text-xs text-slate-500">
                            {make.name}
                          </span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>
            </div>
          )}

          {draft && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
                Current rules
              </div>
              {draft.any.map((condition, index) => (
                <div
                  key={`${optionConditionKey(condition)}-${index}`}
                  className="flex items-start justify-between gap-2 rounded-md bg-slate-50 dark:bg-slate-900 p-2"
                >
                  <OptionConditionChips condition={condition} model={model} />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => removeAt(index)}
                    title="Remove rule"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          <div className="space-y-2 rounded-md border border-slate-200 dark:border-slate-800 p-3">
            <div className="text-xs font-medium text-slate-700 dark:text-slate-300">
              Add an option rule
            </div>
            <ConditionPicker
              model={model}
              value={custom}
              onChange={setCustom}
            />
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!custom || hasCondition(custom)}
                onClick={() => {
                  if (!custom) return
                  toggleCondition(custom)
                  setCustom(null)
                }}
              >
                Add rule
              </Button>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button type="button" size="sm" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
