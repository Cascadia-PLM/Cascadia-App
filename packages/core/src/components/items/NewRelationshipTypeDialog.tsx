// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { Link2 } from 'lucide-react'
import type { TargetItem } from '@/components/items/bom-target-scope'
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
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { useInvalidateResources } from '@/lib/query'
import { StateBadge } from '@/components/items/StateBadge'

interface NewRelationshipTypeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string
  onSuccess: () => void
}

// Common relationship type suggestions
const RELATIONSHIP_TYPE_SUGGESTIONS = [
  'BOM',
  'Child Part',
  'Parent Part',
  'Related Part',
  'Superseded By',
  'Supersedes',
  'Affected Item',
  'Affected By',
  'Deliverable',
  'Dependency',
  'Reference',
  'Attachment',
]

export function NewRelationshipTypeDialog({
  open,
  onOpenChange,
  itemId,
  onSuccess,
}: NewRelationshipTypeDialogProps) {
  const { alert } = useAlertDialog()
  const invalidate = useInvalidateResources()
  const [relationshipType, setRelationshipType] = useState('')
  const [customType, setCustomType] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [itemType, setItemType] = useState('Part')
  const [selectedItem, setSelectedItem] = useState<TargetItem | null>(null)
  const [quantity, setQuantity] = useState('')
  const [referenceDesignator, setReferenceDesignator] = useState('')
  const [findNumber, setFindNumber] = useState('')
  const [loading, setLoading] = useState(false)

  const finalType =
    relationshipType === 'custom' ? customType : relationshipType

  // Under BOM this is the source item's design plus the Standard Library —
  // including when the user reaches BOM by typing it as a custom type
  const {
    scope: bomScope,
    candidates,
    loading: searching,
  } = useRelationshipTargets({
    itemId,
    relationshipType: finalType,
    itemType,
    search: searchQuery,
  })

  // The type decides what may be picked, so crossing into or out of BOM drops
  // a pick made under the old rules — otherwise a part from another design,
  // chosen while the type was "Reference", could be submitted as a BOM line
  const applyType = (nextRelationshipType: string, nextCustomType: string) => {
    const nextFinal =
      nextRelationshipType === 'custom' ? nextCustomType : nextRelationshipType
    if ((nextFinal === BOM_RELATIONSHIP_TYPE) !== bomScope.active) {
      setSelectedItem(null)
    }
    setRelationshipType(nextRelationshipType)
    setCustomType(nextCustomType)
  }

  const handleAdd = async () => {
    if (!selectedItem) return

    if (!finalType) {
      alert({
        title: 'Error',
        description: 'Please specify a relationship type',
        variant: 'destructive',
      })
      return
    }

    setLoading(true)
    try {
      await apiFetch(`/api/v1/items/${itemId}/relationships`, {
        method: 'POST',
        body: JSON.stringify({
          targetId: selectedItem.id,
          relationshipType: finalType,
          quantity: quantity || null,
          referenceDesignator: referenceDesignator || null,
          findNumber: findNumber ? parseInt(findNumber) : null,
        }),
      })

      await invalidate('relationships')
      onSuccess()
      // Reset form
      setRelationshipType('')
      setCustomType('')
      setSelectedItem(null)
      setQuantity('')
      setReferenceDesignator('')
      setFindNumber('')
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to add relationship',
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
          <DialogTitle>Add New Relationship Type</DialogTitle>
          <DialogDescription>
            Create a new relationship type and add the first related item
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Relationship Type Selection */}
          <div>
            <Label>Relationship Type</Label>
            <Select
              value={relationshipType}
              onValueChange={(value) => applyType(value, customType)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select or create a type..." />
              </SelectTrigger>
              <SelectContent>
                {RELATIONSHIP_TYPE_SUGGESTIONS.map((type) => (
                  <SelectItem key={type} value={type}>
                    {type}
                  </SelectItem>
                ))}
                <SelectItem value="custom">Custom Type...</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Custom Type Input */}
          {relationshipType === 'custom' && (
            <div>
              <Label htmlFor="customType">Custom Relationship Type</Label>
              <Input
                id="customType"
                type="text"
                placeholder="Enter custom type name..."
                value={customType}
                onChange={(e) => applyType(relationshipType, e.target.value)}
              />
            </div>
          )}

          {/* Item Type Selection — fixed to Part while BOM confines the picker */}
          {bomScope.active ? (
            <BomScopeNotice scope={bomScope} />
          ) : (
            <div>
              <Label>Target Item Type</Label>
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
            <Label>Search Items</Label>
            <Input
              type="text"
              placeholder="Search by item number or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          {/* Search Results */}
          <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-60 overflow-y-auto auto-hide-scroll">
            {searching ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                Searching...
              </div>
            ) : candidates.length === 0 ? (
              <div className="p-4 text-center text-sm text-slate-500 dark:text-slate-400">
                No items found
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-700">
                {candidates.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedItem(item)}
                    className={`w-full px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors ${
                      selectedItem?.id === item.id
                        ? 'bg-cyan-50 dark:bg-cyan-950'
                        : ''
                    }`}
                  >
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
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Relationship Details */}
          {selectedItem && (
            <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-900 rounded-lg">
              <h4 className="font-medium text-sm">
                Relationship Details (Optional)
              </h4>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label htmlFor="quantity">Quantity</Label>
                  <Input
                    id="quantity"
                    type="text"
                    placeholder="1"
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                  />
                </div>

                <div>
                  <Label htmlFor="refDes">Ref Designator</Label>
                  <Input
                    id="refDes"
                    type="text"
                    placeholder="R1, C1"
                    value={referenceDesignator}
                    onChange={(e) => setReferenceDesignator(e.target.value)}
                  />
                </div>

                <div>
                  <Label htmlFor="findNum">Find Number</Label>
                  <Input
                    id="findNum"
                    type="number"
                    placeholder="1"
                    value={findNumber}
                    onChange={(e) => setFindNumber(e.target.value)}
                  />
                </div>
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
            disabled={
              !selectedItem ||
              !relationshipType ||
              (relationshipType === 'custom' && !customType) ||
              loading
            }
          >
            {loading ? 'Adding...' : 'Add Relationship'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
