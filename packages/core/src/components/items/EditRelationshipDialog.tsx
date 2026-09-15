// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import type { Make, OptionCondition, OptionModel } from '@/lib/types/variants'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Label } from '@/components/ui/Label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { BOM_RELATIONSHIP_TYPE } from '@/components/items/bom-target-scope'
import { isValidQuantity } from '@/components/items/bom-quantity'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'
import { useInvalidateResources } from '@/lib/query'
import { cn } from '@/lib/utils'
import { OptionConditionChips } from '@/components/variants/OptionConditionChips'

/** The line being edited — the columns `PUT /relationships/:id` can change. */
export interface EditableRelationship {
  id: string
  relationshipType: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  /** Product variants: shown here, edited from the row's option icon. */
  option?: OptionCondition | null
  targetMakeCode?: string | null
  targetItem: {
    itemNumber: string
    name?: string | null
    makes?: Array<Make> | null
  }
}

interface EditRelationshipDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  relationship: EditableRelationship
  /** For labelling the option chips; the parent part's model. */
  optionModel?: OptionModel | null
  onSuccess?: () => void
}

/**
 * Edit the line properties of an existing relationship — quantity, reference
 * designator, find number — via `PUT /api/v1/relationships/:id`. Before this
 * existed the only way to correct a quantity was deleting the line and
 * re-adding it, which is a structural change, not a correction.
 *
 * Mount fresh per edit (`{editing && <EditRelationshipDialog …>}`) so the
 * fields initialise from the row being edited.
 */
export function EditRelationshipDialog({
  open,
  onOpenChange,
  relationship,
  optionModel,
  onSuccess,
}: EditRelationshipDialogProps) {
  const { handleError } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [quantity, setQuantity] = useState(relationship.quantity ?? '')
  const [referenceDesignator, setReferenceDesignator] = useState(
    relationship.referenceDesignator ?? '',
  )
  const [findNumber, setFindNumber] = useState(
    relationship.findNumber !== null ? String(relationship.findNumber) : '',
  )
  const [saving, setSaving] = useState(false)
  const [targetMakeCode, setTargetMakeCode] = useState(
    relationship.targetMakeCode ?? '__none__',
  )

  const isBom = relationship.relationshipType === BOM_RELATIONSHIP_TYPE
  // A BOM line requires a quantity; on any line, a non-empty value must be a
  // decimal the numeric column can hold.
  const quantityInvalid = isBom
    ? !isValidQuantity(quantity)
    : quantity.trim() !== '' && !isValidQuantity(quantity)

  const handleSave = async () => {
    if (quantityInvalid) return

    setSaving(true)
    try {
      await apiFetch(`/api/v1/relationships/${relationship.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          quantity: quantity.trim() || null,
          referenceDesignator: referenceDesignator.trim() || null,
          findNumber: findNumber ? parseInt(findNumber, 10) : null,
          targetMakeCode: targetMakeCode === '__none__' ? null : targetMakeCode,
        }),
      })
      await invalidate('relationships')
      onOpenChange(false)
      onSuccess?.()
    } catch (error) {
      handleError(error, { title: 'Failed to update relationship' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {relationship.relationshipType} Line</DialogTitle>
          <DialogDescription>
            {relationship.targetItem.itemNumber}
            {relationship.targetItem.name
              ? ` — ${relationship.targetItem.name}`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="edit-rel-quantity">
              Quantity{isBom ? '' : ' (optional)'}
            </Label>
            <Input
              id="edit-rel-quantity"
              type="text"
              inputMode="decimal"
              placeholder="1"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              className={cn(
                quantityInvalid &&
                  'border-red-500 focus-visible:ring-red-500 dark:border-red-500',
              )}
            />
            {quantityInvalid && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {isBom
                  ? 'A BOM line needs a decimal quantity, e.g. 4 or 2.5'
                  : 'Quantity must be a decimal, e.g. 4 or 2.5'}
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="edit-rel-refdes">Ref Designator</Label>
            <Input
              id="edit-rel-refdes"
              type="text"
              placeholder="R1, C1"
              value={referenceDesignator}
              onChange={(e) => setReferenceDesignator(e.target.value)}
            />
          </div>

          <div>
            <Label htmlFor="edit-rel-findnum">Find Number</Label>
            <Input
              id="edit-rel-findnum"
              type="number"
              placeholder="1"
              value={findNumber}
              onChange={(e) => setFindNumber(e.target.value)}
            />
          </div>
        </div>

        {isBom && (relationship.targetItem.makes?.length ?? 0) > 0 && (
          <div>
            <Label htmlFor="edit-rel-execution">Target execution</Label>
            <Select value={targetMakeCode} onValueChange={setTargetMakeCode}>
              <SelectTrigger id="edit-rel-execution">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">Unspecified</SelectItem>
                {relationship.targetItem.makes
                  ?.filter((make) => make.active)
                  .map((make) => (
                    <SelectItem key={make.code} value={make.code}>
                      {make.code}
                      {make.name ? ` — ${make.name}` : ''}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Pins this BOM line to an execution of the target revision.
            </p>
          </div>
        )}

        {relationship.option && (
          <div className="text-sm">
            <span className="text-slate-500 dark:text-slate-400 mr-2">
              Option condition
            </span>
            <OptionConditionChips
              condition={relationship.option}
              model={optionModel}
            />
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Change it from the option icon on the line.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || quantityInvalid}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
