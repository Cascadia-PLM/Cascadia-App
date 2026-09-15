// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { ConditionPicker } from './ConditionPicker'
import type { OptionCondition, OptionModel } from '@/lib/types/variants'
import {
  Button,
  Input,
  Label,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useResourceMutation } from '@/lib/query'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { OPTION_CODE_PATTERN } from '@/lib/types/variants'

/**
 * The one place a design with no variants ever sees variant UI: an icon on a
 * BOM row that opens a picker for the line's option condition.
 *
 * The picker lists the parent part's option families. When the parent has
 * none, or the user needs another, "New family" creates one inline — which
 * is what makes a part configurable in the first place. Both writes go
 * through the ordinary item and relationship routes, so checkout and branch
 * protection apply as they do to a quantity edit.
 */
export function OptionConditionPopover({
  relationshipId,
  option,
  parent,
  disabled,
}: {
  relationshipId: string
  option: OptionCondition | null | undefined
  parent: { id: string; optionModel?: OptionModel | null }
  disabled?: boolean
}) {
  const { alert } = useAlertDialog()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<OptionCondition | null>(option ?? null)
  const [showNewFamily, setShowNewFamily] = useState(false)
  const [newCode, setNewCode] = useState('')
  const [newName, setNewName] = useState('')
  const [newValues, setNewValues] = useState('')

  const model: OptionModel = parent.optionModel ?? {
    families: [],
    constraints: [],
  }

  const fail = (title: string) => (error: unknown) =>
    alert({
      title,
      description: error instanceof Error ? error.message : title,
      variant: 'destructive',
    })

  const saveLine = useResourceMutation({
    mutationFn: (next: OptionCondition | null) =>
      apiFetch(`/api/v1/relationships/${relationshipId}`, {
        method: 'PUT',
        body: JSON.stringify({ option: next }),
      }),
    invalidates: ['relationships'],
    onSuccess: () => setOpen(false),
    onError: fail('Failed to update the option condition'),
  })

  const addFamily = useResourceMutation({
    mutationFn: (next: OptionModel) =>
      apiFetch(`/api/v1/parts/${parent.id}`, {
        method: 'PUT',
        body: JSON.stringify({ optionModel: next }),
      }),
    invalidates: ['parts'],
    onSuccess: () => {
      setShowNewFamily(false)
      setNewCode('')
      setNewName('')
      setNewValues('')
    },
    onError: fail('Failed to add the option family'),
  })

  const newCodeValid = OPTION_CODE_PATTERN.test(newCode.trim().toLowerCase())
  const parsedValues = newValues
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
  const canAddFamily =
    newCodeValid &&
    newName.trim().length > 0 &&
    parsedValues.length > 0 &&
    !model.families.some((f) => f.code === newCode.trim().toLowerCase())

  const submitFamily = () => {
    const code = newCode.trim().toLowerCase()
    addFamily.mutate({
      families: [
        ...model.families,
        {
          code,
          name: newName.trim(),
          required: true,
          values: parsedValues.map((label) => ({
            code: label.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
            label,
          })),
        },
      ],
      constraints: model.constraints,
    })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setDraft(option ?? null)
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          aria-label="Option condition"
          title="Option condition"
          disabled={disabled}
        >
          <SlidersHorizontal
            className={`h-4 w-4 ${option ? 'text-cyan-600 dark:text-cyan-400' : 'text-slate-400'}`}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="space-y-3">
          <div>
            <div className="text-sm font-medium">Option condition</div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Tick the selections that put this line in the BOM. Nothing ticked
              means the line is always present.
            </p>
          </div>

          <ConditionPicker model={model} value={draft} onChange={setDraft} />

          {showNewFamily ? (
            <div className="space-y-2 rounded-md border border-slate-200 dark:border-slate-800 p-2">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label htmlFor="opt-new-code" className="text-xs">
                    Code
                  </Label>
                  <Input
                    id="opt-new-code"
                    className="h-8 text-sm font-mono"
                    placeholder="color"
                    value={newCode}
                    onChange={(e) => setNewCode(e.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor="opt-new-name" className="text-xs">
                    Name
                  </Label>
                  <Input
                    id="opt-new-name"
                    className="h-8 text-sm"
                    placeholder="Colour"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <Label htmlFor="opt-new-values" className="text-xs">
                  Values, comma separated
                </Label>
                <Input
                  id="opt-new-values"
                  className="h-8 text-sm"
                  placeholder="Black, White"
                  value={newValues}
                  onChange={(e) => setNewValues(e.target.value)}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowNewFamily(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canAddFamily || addFamily.isPending}
                  onClick={submitFamily}
                >
                  Add family
                </Button>
              </div>
            </div>
          ) : (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs"
              onClick={() => setShowNewFamily(true)}
            >
              + New family
            </Button>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={saveLine.isPending}
              onClick={() => saveLine.mutate(draft)}
            >
              Save
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
