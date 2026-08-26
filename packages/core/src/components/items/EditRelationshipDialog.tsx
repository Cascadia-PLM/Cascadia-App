// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
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
import { BOM_RELATIONSHIP_TYPE } from '@/components/items/bom-target-scope'
import { isValidQuantity } from '@/components/items/bom-quantity'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { useInvalidateResources } from '@/lib/query'
import { cn } from '@/lib/utils'

/** The line being edited — the columns `PUT /relationships/:id` can change. */
export interface EditableRelationship {
  id: string
  relationshipType: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  targetItem: {
    itemNumber: string
    name?: string | null
  }
}

interface EditRelationshipDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  relationship: EditableRelationship
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
  onSuccess,
}: EditRelationshipDialogProps) {
  const { alert } = useAlertDialog()
  const invalidate = useInvalidateResources()
  const [quantity, setQuantity] = useState(relationship.quantity ?? '')
  const [referenceDesignator, setReferenceDesignator] = useState(
    relationship.referenceDesignator ?? '',
  )
  const [findNumber, setFindNumber] = useState(
    relationship.findNumber !== null ? String(relationship.findNumber) : '',
  )
  const [saving, setSaving] = useState(false)

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
        }),
      })
      await invalidate('relationships')
      onOpenChange(false)
      onSuccess?.()
    } catch (error) {
      alert({
        title: 'Failed to update relationship',
        description:
          error instanceof Error
            ? error.message
            : 'Failed to update relationship',
        variant: 'destructive',
      })
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
