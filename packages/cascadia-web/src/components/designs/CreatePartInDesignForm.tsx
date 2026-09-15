// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft, Info } from 'lucide-react'
import type { FormEvent } from 'react'
import type { PartType } from '@cascadia/commons/lib/items/types/part'
import {
  Button,
  ViewEditNumber,
  ViewEditSelect,
  ViewEditText,
  ViewEditTextarea,
} from '@/components/ui'
import { DialogFooter } from '@/components/ui/Dialog'
import { PART_TYPE_OPTIONS } from '@/components/parts/PartManufacturingCard'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'
import { designStatusQuery, useResourceMutation } from '@/lib/query'

/**
 * What the create hands back that the caller needs. The item type's own
 * shape leaves `itemNumber` optional because a create may omit it; the
 * response never does — the server numbered it if the form did not.
 */
interface CreatedPart {
  id: string
  itemNumber: string
}

interface CreatePartInDesignFormProps {
  designId: string
  designCode: string
  /**
   * The branch the design page is viewing. Undefined creates on main, which
   * is where a pre-release design's parts belong; once main is protected the
   * page has to be on a change-order or workspace branch for a create to
   * have somewhere to land.
   */
  branchId?: string
  /**
   * When set, the new part is placed under this part with the quantity and
   * find number given, instead of standing at the top level. Nesting
   * withdraws the top-level designation the create made, so the tree shows
   * it under its parent only.
   */
  parent?: { id: string; itemNumber: string }
  onBack: () => void
  onCreated: (part: CreatedPart) => void
}

/**
 * The outcome of the one or two writes. A part that exists but could not
 * be nested is a success with a caveat, not a failure: the create still has
 * to refresh the tree, where the part now stands at the top level for Use
 * Existing to nest.
 */
interface CreateOutcome {
  item: CreatedPart
  nestError?: string
}

/**
 * The part form cut down to what a new part needs here: number (blank
 * auto-numbers), type, name, description — and, under a parent, the BOM
 * line's quantity and find number. Everything else — material, mass, cost,
 * sourcing, files — is edited on the part's own page afterwards.
 *
 * Creating a Part in a design designates it a top-level part of the design's
 * structure (see `ItemService.create`), so at the top level there is nothing
 * to attach: the tree shows it as a root as soon as the structure query
 * refreshes. Under a parent, the BOM line is the second write, and nesting
 * clears the designation the way it does for any other child.
 */
export function CreatePartInDesignForm({
  designId,
  designCode,
  branchId,
  parent,
  onBack,
  onCreated,
}: CreatePartInDesignFormProps) {
  const { handleError, showSuccess, showWarning } = useErrorHandler()
  const [itemNumber, setItemNumber] = useState('')
  const [name, setName] = useState('')
  const [partType, setPartType] = useState<PartType>('Manufacture')
  const [description, setDescription] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [findNumber, setFindNumber] = useState('')

  // A protected main refuses the create; say so before the attempt rather
  // than after it. Shared query key with the page's phase card, so this
  // costs no extra request.
  const { data: status } = useQuery(designStatusQuery(designId))
  const mainProtected = status?.protection.isMainBranchProtected ?? false
  const blocked = mainProtected && !branchId

  const createPart = useResourceMutation({
    mutationFn: async (): Promise<CreateOutcome> => {
      const {
        data: { item },
      } = await apiFetch<{ data: { item: CreatedPart } }>('/api/v1/items', {
        method: 'POST',
        body: JSON.stringify({
          itemType: 'Part',
          designId,
          name: name.trim(),
          itemNumber: itemNumber.trim() || undefined,
          partType,
          description: description.trim() || undefined,
          ...(branchId && { branchId }),
        }),
      })
      if (!parent) return { item }

      // The same line Use Existing writes, against the same parent.
      try {
        await apiFetch(`/api/v1/items/${parent.id}/relationships`, {
          method: 'POST',
          body: JSON.stringify({
            targetId: item.id,
            relationshipType: 'BOM',
            quantity: quantity.trim() || '1',
            findNumber: findNumber.trim()
              ? parseInt(findNumber, 10)
              : undefined,
          }),
        })
        return { item }
      } catch (error) {
        return {
          item,
          nestError:
            error instanceof Error ? error.message : 'The BOM line was refused',
        }
      }
    },
    invalidates: parent ? ['parts', 'relationships'] : ['parts'],
    onSuccess: ({ item, nestError }) => {
      if (nestError) {
        showWarning(
          `${item.itemNumber} was created, but not placed under ${parent?.itemNumber}`,
          nestError,
        )
      } else if (parent) {
        showSuccess(
          'Part created',
          `${item.itemNumber} is now under ${parent.itemNumber}`,
        )
      } else {
        showSuccess(
          'Part created',
          `${item.itemNumber} is now a top-level part of ${designCode}`,
        )
      }
      onCreated(item)
    },
    onError: (error: unknown) => {
      handleError(error, { title: 'Failed to create part' })
    },
  })

  const quantityValid = !parent || Number(quantity) > 0
  const canSubmit =
    name.trim().length > 0 && quantityValid && !blocked && !createPart.isPending

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (canSubmit) createPart.mutate()
  }

  return (
    <form onSubmit={handleSubmit} data-testid="create-part-form">
      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <ViewEditText
          label="Item Number"
          value={itemNumber}
          onChange={setItemNumber}
          isEditing
          placeholder="Leave blank to auto-number"
          data-testid="create-part-item-number"
        />
        <ViewEditSelect
          label="Type"
          value={partType}
          onChange={(value) => setPartType(value as PartType)}
          isEditing
          options={PART_TYPE_OPTIONS}
          data-testid="create-part-type"
        />
        <ViewEditText
          label="Name"
          value={name}
          onChange={setName}
          isEditing
          placeholder="Part name"
          required
          className="md:col-span-2"
          data-testid="create-part-name"
        />
        <ViewEditTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          isEditing
          placeholder="Enter a description..."
          className="md:col-span-2"
        />
        {parent && (
          <>
            <ViewEditNumber
              label="Quantity"
              value={quantity}
              onChange={setQuantity}
              isEditing
              step="any"
              min={0}
              required
            />
            <ViewEditNumber
              label="Find Number"
              value={findNumber}
              onChange={setFindNumber}
              isEditing
              min={1}
              placeholder="Optional"
            />
          </>
        )}
      </dl>

      {blocked && (
        <div className="flex items-start gap-2 mt-4 p-3 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-sm rounded-md">
          <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>
            This design is under change control, so nothing can be created on
            main. Switch the page to a change-order or workspace branch and the
            part will be created there.
          </span>
        </div>
      )}

      <DialogFooter className="mt-6">
        <Button
          type="button"
          variant="ghost"
          className="mr-auto"
          onClick={onBack}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back
        </Button>
        <Button
          type="submit"
          disabled={!canSubmit}
          data-testid="create-part-submit"
        >
          {createPart.isPending
            ? 'Creating...'
            : parent
              ? 'Create and Add to BOM'
              : 'Create Part'}
        </Button>
      </DialogFooter>
    </form>
  )
}
