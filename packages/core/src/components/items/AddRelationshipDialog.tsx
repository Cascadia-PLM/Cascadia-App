// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Check, Link2, X } from 'lucide-react'
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
import { Badge } from '@/components/ui/Badge'
import {
  BOM_RELATIONSHIP_TYPE,
  BomScopeNotice,
  useRelationshipTargets,
} from '@/components/items/bom-target-scope'
import {
  DEFAULT_BOM_QUANTITY,
  isValidQuantity,
} from '@/components/items/bom-quantity'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useListSelection } from '@/lib/hooks/useListSelection'
import { apiFetch } from '@/lib/api/client'
import { useInvalidateResources } from '@/lib/query'
import { StateBadge } from '@/components/items/StateBadge'
import { cn } from '@/lib/utils'

interface AddRelationshipDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string
  relationshipType: string
  onSuccess: () => void
}

/** The optional per-line fields, as typed into the form. */
interface LineDetails {
  quantity: string
  referenceDesignator: string
  findNumber: string
}

const EMPTY_DETAILS: LineDetails = {
  quantity: '',
  referenceDesignator: '',
  findNumber: '',
}

/**
 * A BOM line starts at quantity 1 — as a real value, not a placeholder. The
 * field used to show `1` as a placeholder and submit nothing, so every line
 * left untouched was created with a null quantity.
 */
const BOM_DEFAULT_DETAILS: LineDetails = {
  ...EMPTY_DETAILS,
  quantity: DEFAULT_BOM_QUANTITY,
}

/** What `POST /api/v1/relationships/batch-create` reports back. */
interface BatchCreateResult {
  created: number
  /** Rows that already existed as relationships, so the server left them be. */
  skipped: number
  errors: Array<{ error: string; details?: string }>
}

export function AddRelationshipDialog({
  open,
  onOpenChange,
  itemId,
  relationshipType,
  onSuccess,
}: AddRelationshipDialogProps) {
  const { alert } = useAlertDialog()
  const invalidate = useInvalidateResources()
  const [searchQuery, setSearchQuery] = useState('')
  const [itemType, setItemType] = useState('Part')
  const [details, setDetails] = useState<Record<string, LineDetails>>({})
  const [loading, setLoading] = useState(false)

  // Under BOM this is the source item's design plus the Standard Library;
  // otherwise the plain by-type search
  const {
    scope: bomScope,
    candidates,
    loading: searching,
  } = useRelationshipTargets({
    itemId,
    relationshipType,
    itemType,
    search: searchQuery,
  })

  const selection = useListSelection(candidates)
  const selectedCount = selection.selected.length

  const isBom = relationshipType === BOM_RELATIONSHIP_TYPE
  const defaultDetails = isBom ? BOM_DEFAULT_DETAILS : EMPTY_DETAILS

  const setDetail = (
    id: string,
    field: keyof LineDetails,
    value: string,
  ): void => {
    setDetails((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? defaultDetails), [field]: value },
    }))
  }

  // A BOM line requires a quantity; on any line, a non-empty value must be a
  // decimal the numeric column can hold.
  const lineQuantityInvalid = (line: LineDetails): boolean =>
    isBom
      ? !isValidQuantity(line.quantity)
      : line.quantity.trim() !== '' && !isValidQuantity(line.quantity)

  const hasInvalidQuantity = selection.selected.some((item) =>
    lineQuantityInvalid(details[item.id] ?? defaultDetails),
  )

  const handleAdd = async () => {
    if (selectedCount === 0 || hasInvalidQuantity) return

    setLoading(true)
    try {
      // One request for the whole selection: the batch endpoint groups the
      // history into a single commit per branch rather than one per line, and
      // skips targets already linked instead of inserting a duplicate.
      const { data } = await apiFetch<{ data: BatchCreateResult }>(
        '/api/v1/relationships/batch-create',
        {
          method: 'POST',
          body: JSON.stringify({
            relationships: selection.selected.map((item) => {
              const line = details[item.id] ?? defaultDetails
              return {
                sourceId: itemId,
                targetId: item.id,
                relationshipType,
                quantity: line.quantity.trim() || undefined,
                referenceDesignator: line.referenceDesignator || undefined,
                findNumber: line.findNumber
                  ? parseInt(line.findNumber)
                  : undefined,
              }
            }),
          }),
        },
      )

      await invalidate('relationships')

      // A partial result is the endpoint's normal answer, not an exception, so
      // say what actually landed rather than letting rows vanish silently.
      if (data.skipped > 0 || data.errors.length > 0) {
        const parts = [`Added ${data.created} of ${selectedCount}`]
        if (data.skipped > 0) parts.push(`${data.skipped} already linked`)
        if (data.errors.length > 0) parts.push(`${data.errors.length} failed`)
        alert({
          title: data.created > 0 ? 'Partially added' : 'Nothing added',
          description: `${parts.join('. ')}.`,
          variant: data.created > 0 ? 'default' : 'destructive',
        })
      }

      // Nothing landed, so keep the dialog up with the selection intact —
      // closing it would look like the add had worked.
      if (data.created === 0) return

      onSuccess()
      selection.clear()
      setDetails({})
    } catch (error) {
      alert({
        title:
          selectedCount === 1
            ? 'Failed to add relationship'
            : 'Failed to add relationships',
        description:
          error instanceof Error
            ? error.message
            : 'Failed to add relationships',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle>Add {relationshipType}</DialogTitle>
          <DialogDescription>
            Search for items to add as {relationshipType.toLowerCase()}. Pick as
            many as you need — they are added together.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Item Type Selection — fixed to Part while BOM confines the picker */}
          {bomScope.active ? (
            <BomScopeNotice scope={bomScope} />
          ) : (
            <div>
              <Label>Item Type</Label>
              <Select value={itemType} onValueChange={setItemType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Part">Part</SelectItem>
                  <SelectItem value="Document">Document</SelectItem>
                  <SelectItem value="Requirement">Requirement</SelectItem>
                  <SelectItem value="Task">Task</SelectItem>
                  <SelectItem value="ChangeOrder">Change Order</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Search Input */}
          <div>
            <Label>Search</Label>
            <Input
              type="text"
              placeholder="Search by item number or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Search Results */}
          <div>
            <div className="flex items-center justify-between gap-3 mb-1.5">
              {/* Says how the modifier keys work, because a list that looks
                  single-select gives no hint that they do */}
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Click to select. Shift+click for a range, Ctrl/Cmd+click to add
                one at a time.
              </p>
              <div className="flex items-center gap-3 shrink-0">
                {candidates.length > 0 && !selection.allVisibleSelected && (
                  <button
                    type="button"
                    onClick={selection.selectAll}
                    className="text-xs text-cyan-700 dark:text-cyan-400 hover:underline"
                  >
                    Select all
                  </button>
                )}
                {selectedCount > 0 && (
                  <button
                    type="button"
                    onClick={selection.clear}
                    className="text-xs text-slate-600 dark:text-slate-400 hover:underline"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>

            {/* select-none so a shift+click extends the range instead of
                dragging a text selection across the rows */}
            <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-60 overflow-y-auto auto-hide-scroll select-none">
              {searching ? (
                <div className="p-4 text-center text-sm text-slate-500">
                  Searching...
                </div>
              ) : candidates.length === 0 ? (
                <div className="p-4 text-center text-sm text-slate-500">
                  No items found
                </div>
              ) : (
                <div className="divide-y divide-slate-200 dark:divide-slate-700">
                  {candidates.map((item) => {
                    const isSelected = selection.isSelected(item.id)
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={(e) => selection.handleRowClick(item, e)}
                        className={`w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors ${
                          isSelected ? 'bg-cyan-50 dark:bg-cyan-950' : ''
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          {/* Presentational: the row itself is the control, so
                              a real checkbox here would nest one button in
                              another */}
                          <span
                            aria-hidden="true"
                            className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                              isSelected
                                ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-50 dark:bg-slate-50 dark:text-slate-900'
                                : 'border-slate-400 dark:border-slate-600'
                            }`}
                          >
                            {isSelected && <Check className="h-3 w-3" />}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                                {item.itemNumber}
                              </span>
                              <Badge variant="outline" className="text-xs">
                                {item.revision}
                              </Badge>
                              <StateBadge
                                itemType={itemType}
                                state={item.state}
                                className="text-xs"
                              />
                              {/* Marks the library hits apart from this design's own */}
                              {item.isExternal && item.designCode && (
                                <Badge
                                  variant="outline"
                                  className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600"
                                >
                                  <Link2 className="h-3 w-3 mr-1" />
                                  {item.designCode}
                                </Badge>
                              )}
                            </div>
                            {item.name && (
                              <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
                                {item.name}
                              </p>
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Relationship Details — one line per chosen item, since a
              reference designator and a find number belong to the line rather
              than to the batch. Selections survive a new search term, so this
              doubles as the running list of what is about to be added. */}
          {selectedCount > 0 && (
            <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <div>
                <h4 className="font-medium text-sm">
                  Selected ({selectedCount})
                </h4>
                <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                  {isBom
                    ? 'Every BOM line needs a decimal quantity (e.g. 4 or 2.5). Reference designator and find number are optional.'
                    : 'Quantity, reference designator and find number are optional.'}
                </p>
              </div>

              {/* Outside the scroller, so the columns stay labelled once the
                  selection is long enough to scroll */}
              <div className="grid grid-cols-[minmax(0,1fr)_4rem_6rem_4rem_1.75rem] gap-2 text-xs text-slate-500 dark:text-slate-400 pr-1">
                <span>Item</span>
                <span>Qty</span>
                <span>Ref Des</span>
                <span>Find #</span>
                <span />
              </div>

              <div className="max-h-52 overflow-y-auto auto-hide-scroll space-y-2 pr-1">
                {selection.selected.map((item) => {
                  const line = details[item.id] ?? defaultDetails
                  return (
                    <div
                      key={item.id}
                      className="grid grid-cols-[minmax(0,1fr)_4rem_6rem_4rem_1.75rem] gap-2 items-center"
                    >
                      <span
                        className="truncate text-sm font-medium text-slate-900 dark:text-slate-100"
                        title={
                          item.name
                            ? `${item.itemNumber} — ${item.name}`
                            : item.itemNumber
                        }
                      >
                        {item.itemNumber}
                      </span>
                      <Input
                        type="text"
                        inputMode="decimal"
                        className={cn(
                          'h-8',
                          lineQuantityInvalid(line) &&
                            'border-red-500 focus-visible:ring-red-500 dark:border-red-500',
                        )}
                        placeholder="1"
                        aria-label={`Quantity for ${item.itemNumber}`}
                        value={line.quantity}
                        onChange={(e) =>
                          setDetail(item.id, 'quantity', e.target.value)
                        }
                      />
                      <Input
                        type="text"
                        className="h-8"
                        placeholder="R1, C1"
                        aria-label={`Reference designator for ${item.itemNumber}`}
                        value={line.referenceDesignator}
                        onChange={(e) =>
                          setDetail(
                            item.id,
                            'referenceDesignator',
                            e.target.value,
                          )
                        }
                      />
                      <Input
                        type="number"
                        className="h-8"
                        placeholder="1"
                        aria-label={`Find number for ${item.itemNumber}`}
                        value={line.findNumber}
                        onChange={(e) =>
                          setDetail(item.id, 'findNumber', e.target.value)
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-8 w-7 px-0"
                        aria-label={`Remove ${item.itemNumber}`}
                        onClick={() => selection.remove(item.id)}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
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
            onClick={handleAdd}
            disabled={selectedCount === 0 || loading || hasInvalidQuantity}
          >
            {loading
              ? 'Adding...'
              : selectedCount > 1
                ? `Add ${selectedCount} Relationships`
                : 'Add Relationship'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
