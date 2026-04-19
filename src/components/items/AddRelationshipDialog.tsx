import { useEffect, useState } from 'react'
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
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface Item {
  id: string
  itemNumber: string
  revision: string
  itemType: string
  name: string
  state: string
}

interface AddRelationshipDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string
  relationshipType: string
  onSuccess: () => void
}

export function AddRelationshipDialog({
  open,
  onOpenChange,
  itemId,
  relationshipType,
  onSuccess,
}: AddRelationshipDialogProps) {
  const { alert } = useAlertDialog()
  const [searchQuery, setSearchQuery] = useState('')
  const [itemType, setItemType] = useState('Part')
  const [searchResults, setSearchResults] = useState<Array<Item>>([])
  const [selectedItem, setSelectedItem] = useState<Item | null>(null)
  const [quantity, setQuantity] = useState('')
  const [referenceDesignator, setReferenceDesignator] = useState('')
  const [findNumber, setFindNumber] = useState('')
  const [loading, setLoading] = useState(false)
  const [searching, setSearching] = useState(false)

  // Search for items
  const handleSearch = async () => {
    if (!itemType) return

    setSearching(true)
    try {
      const params = new URLSearchParams({
        itemType,
        limit: '20',
      })

      const response = await fetch(`/api/items/search?${params}`)
      if (response.ok) {
        const data = await response.json()
        setSearchResults(data.data.items ?? [])
      }
    } catch {
      // Search failed silently
    } finally {
      setSearching(false)
    }
  }

  // Auto-search when itemType changes
  useEffect(() => {
    handleSearch()
  }, [itemType])

  const handleAdd = async () => {
    if (!selectedItem) return

    setLoading(true)
    try {
      const response = await fetch(`/api/items/${itemId}/relationships`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          targetId: selectedItem.id,
          relationshipType,
          quantity: quantity || null,
          referenceDesignator: referenceDesignator || null,
          findNumber: findNumber ? parseInt(findNumber) : null,
        }),
      })

      if (response.ok) {
        onSuccess()
        // Reset form
        setSelectedItem(null)
        setQuantity('')
        setReferenceDesignator('')
        setFindNumber('')
      } else {
        const data = await response.json()
        alert({
          title: 'Error',
          description: data.error || 'Failed to add relationship',
          variant: 'destructive',
        })
      }
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

  // Filter search results based on search query
  const filteredResults = searchQuery
    ? searchResults.filter(
        (item) =>
          item.itemNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
          item.name.toLowerCase().includes(searchQuery.toLowerCase()),
      )
    : searchResults

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto auto-hide-scroll">
        <DialogHeader>
          <DialogTitle>Add {relationshipType}</DialogTitle>
          <DialogDescription>
            Search for an item to add as a {relationshipType.toLowerCase()}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Item Type Selection */}
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
          <div className="border border-slate-300 dark:border-slate-700 rounded-lg max-h-60 overflow-y-auto auto-hide-scroll">
            {searching ? (
              <div className="p-4 text-center text-sm text-slate-500">
                Searching...
              </div>
            ) : filteredResults.length === 0 ? (
              <div className="p-4 text-center text-sm text-slate-500">
                No items found
              </div>
            ) : (
              <div className="divide-y divide-slate-200 dark:divide-slate-700">
                {filteredResults.map((item) => (
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
                      <Badge
                        variant={
                          item.state === 'Released' ? 'default' : 'secondary'
                        }
                        className="text-xs"
                      >
                        {item.state}
                      </Badge>
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
            disabled={!selectedItem || loading}
          >
            {loading ? 'Adding...' : 'Add Relationship'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
