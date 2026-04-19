import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ExternalLink, Plus, Trash2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { AddRelationshipDialog } from './AddRelationshipDialog'
import { NewRelationshipTypeDialog } from './NewRelationshipTypeDialog'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import type { Row } from '@tanstack/react-table'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { DataGrid } from '@/components/ui/DataGrid'
import { ContextMenuItem } from '@/components/ui/ContextMenu'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface Relationship {
  id: string
  sourceId: string
  targetId: string
  relationshipType: string
  quantity: string | null
  referenceDesignator: string | null
  findNumber: number | null
  targetItem: {
    id: string
    itemNumber: string
    revision: string
    itemType: string
    name: string
    state: string
  }
}

interface RelationshipSectionProps {
  itemId: string
  itemType: string
}

export function RelationshipSection({ itemId }: RelationshipSectionProps) {
  const { alert, confirm } = useAlertDialog()
  const [relationships, setRelationships] = useState<Array<Relationship>>([])
  const [loading, setLoading] = useState(true)
  const [expandedTypes, setExpandedTypes] = useState<Set<string>>(new Set())
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false)
  const [selectedType, setSelectedType] = useState<string | null>(null)

  // Load relationships
  const loadRelationships = async () => {
    try {
      const response = await fetch(`/api/items/${itemId}/relationships`)
      if (response.ok) {
        const json = await response.json()
        const fetchedRelationships = json.data?.relationships ?? []
        setRelationships(fetchedRelationships)
        // Auto-expand all types by default
        const types = new Set<string>(
          fetchedRelationships.map((r: Relationship) => r.relationshipType),
        )
        setExpandedTypes(types)
      }
    } catch {
      // Failed to load relationships
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadRelationships()
  }, [itemId])

  // Group relationships by type
  const groupedRelationships = relationships.reduce(
    (acc, rel) => {
      if (!(rel.relationshipType in acc)) {
        acc[rel.relationshipType] = []
      }
      acc[rel.relationshipType].push(rel)
      return acc
    },
    {} as Record<string, Array<Relationship>>,
  )

  const toggleType = (type: string) => {
    const newExpanded = new Set(expandedTypes)
    if (newExpanded.has(type)) {
      newExpanded.delete(type)
    } else {
      newExpanded.add(type)
    }
    setExpandedTypes(newExpanded)
  }

  const handleAddToExistingType = (type: string) => {
    setSelectedType(type)
    setAddDialogOpen(true)
  }

  const handleAddNewType = () => {
    setSelectedType(null)
    setNewTypeDialogOpen(true)
  }

  const handleRemoveRelationship = (relationshipId: string) => {
    confirm({
      title: 'Remove Relationship',
      description: 'Are you sure you want to remove this relationship?',
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const response = await fetch(`/api/relationships/${relationshipId}`, {
            method: 'DELETE',
          })

          if (response.ok) {
            await loadRelationships()
          } else {
            alert({
              title: 'Error',
              description: 'Failed to remove relationship',
              variant: 'destructive',
            })
          }
        } catch {
          alert({
            title: 'Error',
            description: 'Failed to remove relationship',
            variant: 'destructive',
          })
        }
      },
    })
  }

  const handleRelationshipAdded = () => {
    loadRelationships()
    setAddDialogOpen(false)
    setNewTypeDialogOpen(false)
  }

  // Get unique states for filter options
  const stateOptions = useMemo(() => {
    const states = new Set(relationships.map((r) => r.targetItem.state))
    return Array.from(states).map((state) => ({ label: state, value: state }))
  }, [relationships])

  // Get unique item types for filter options
  const itemTypeOptions = useMemo(() => {
    const types = new Set(relationships.map((r) => r.targetItem.itemType))
    return Array.from(types).map((type) => ({ label: type, value: type }))
  }, [relationships])

  // Get URL for relationship row (for "Open in new tab")
  const getRowUrl = useCallback((row: Relationship) => {
    const itemType = row.targetItem.itemType.toLowerCase() + 's'
    return `/${itemType}/${row.targetItem.id}`
  }, [])

  // Context menu items (Remove)
  const renderContextMenuItems = useCallback((row: Row<Relationship>) => {
    return (
      <ContextMenuItem
        onClick={() => handleRemoveRelationship(row.original.id)}
        className="text-red-600 focus:text-red-600"
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Remove
      </ContextMenuItem>
    )
  }, [])

  // Define columns for the DataGrid
  const columns: Array<DataGridColumn<Relationship>> = useMemo(
    () => [
      {
        id: 'findNumber',
        header: 'Find #',
        accessorFn: (row) => row.findNumber,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'range' as const,
        meta: { width: '70px', align: 'center' as const },
        cell: ({ getValue }) => {
          const value = getValue() as number | null
          return value ?? '-'
        },
      },
      {
        id: 'itemNumber',
        header: 'Item Number',
        accessorFn: (row) => row.targetItem.itemNumber,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text' as const,
        filterPlaceholder: 'Filter item number...',
        cell: ({ row }) => {
          const rel = row.original
          const itemType = rel.targetItem.itemType.toLowerCase() + 's'
          return (
            <Link
              to={`/${itemType}/${rel.targetItem.id}` as any}
              className="font-medium text-cyan-600 hover:text-cyan-700 hover:underline flex items-center gap-1"
            >
              {rel.targetItem.itemNumber}
              <ExternalLink className="h-3 w-3" />
            </Link>
          )
        },
      },
      {
        id: 'revision',
        header: 'Rev',
        accessorFn: (row) => row.targetItem.revision,
        enableSorting: true,
        enableFiltering: false,
        meta: { width: '60px', align: 'center' as const },
        cell: ({ getValue }) => (
          <Badge variant="outline" className="text-xs">
            {getValue() as string}
          </Badge>
        ),
      },
      {
        id: 'name',
        header: 'Name',
        accessorFn: (row) => row.targetItem.name,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text' as const,
        filterPlaceholder: 'Filter name...',
        cell: ({ getValue }) => {
          const value = getValue() as string | null
          return (
            <span className="text-slate-600 dark:text-slate-400">
              {value || '-'}
            </span>
          )
        },
      },
      {
        id: 'itemType',
        header: 'Type',
        accessorFn: (row) => row.targetItem.itemType,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect' as const,
        filterOptions: itemTypeOptions,
        meta: { width: '90px' },
        cell: ({ getValue }) => (
          <Badge variant="outline" className="text-xs">
            {getValue() as string}
          </Badge>
        ),
      },
      {
        id: 'state',
        header: 'State',
        accessorFn: (row) => row.targetItem.state,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'multiSelect' as const,
        filterOptions: stateOptions,
        meta: { width: '100px' },
        cell: ({ getValue }) => {
          const state = getValue() as string
          return (
            <Badge
              variant={state === 'Released' ? 'default' : 'secondary'}
              className="text-xs"
            >
              {state}
            </Badge>
          )
        },
      },
      {
        id: 'quantity',
        header: 'Qty',
        accessorFn: (row) => (row.quantity ? parseFloat(row.quantity) : null),
        enableSorting: true,
        enableFiltering: true,
        filterType: 'range' as const,
        meta: { width: '70px', align: 'right' as const },
        cell: ({ row }) => {
          const qty = row.original.quantity
          return qty ?? '-'
        },
      },
      {
        id: 'referenceDesignator',
        header: 'Ref Designator',
        accessorFn: (row) => row.referenceDesignator,
        enableSorting: true,
        enableFiltering: true,
        filterType: 'text' as const,
        filterPlaceholder: 'Filter ref des...',
        cell: ({ getValue }) => {
          const value = getValue() as string | null
          return (
            <span className="font-mono text-sm text-slate-600 dark:text-slate-400">
              {value || '-'}
            </span>
          )
        },
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        enableFiltering: false,
        meta: { width: '50px', align: 'center' as const },
        cell: ({ row }) => (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => handleRemoveRelationship(row.original.id)}
            className="h-8 w-8 p-0"
          >
            <Trash2 className="h-4 w-4 text-red-600" />
          </Button>
        ),
      },
    ],
    [stateOptions, itemTypeOptions],
  )

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Relationships</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Loading relationships...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>Relationships</CardTitle>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleAddNewType}
            >
              <Plus className="h-4 w-4 mr-1" />
              New Relationship Type
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {Object.keys(groupedRelationships).length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-slate-500 mb-4">
                No relationships yet
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleAddNewType}
              >
                <Plus className="h-4 w-4 mr-1" />
                Add First Relationship
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {Object.entries(groupedRelationships).map(([type, rels]) => (
                <div key={type} className="border rounded-lg overflow-hidden">
                  <div className="bg-slate-50 dark:bg-slate-900 px-4 py-3 flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => toggleType(type)}
                      className="flex items-center gap-2 text-sm font-medium hover:text-cyan-600 transition-colors"
                    >
                      <div
                        className={`chevron-rotate ${expandedTypes.has(type) ? 'chevron-rotate-down' : 'chevron-rotate-right'}`}
                      >
                        <ChevronDown className="h-4 w-4" />
                      </div>
                      {type}
                      <Badge
                        variant="secondary"
                        className="animate-badge-pulse"
                      >
                        {rels.length}
                      </Badge>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAddToExistingType(type)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  </div>

                  {expandedTypes.has(type) && (
                    <div className="p-4 tree-expand-enter">
                      <DataGrid
                        data={rels}
                        columns={columns}
                        getRowId={(row) => row.id}
                        enablePagination={rels.length > 10}
                        defaultPageSize={10}
                        enableGlobalFilter={rels.length > 5}
                        enableContextMenu
                        getRowUrl={getRowUrl}
                        renderContextMenuItems={renderContextMenuItems}
                        emptyMessage="No relationships"
                        emptyDescription="Add items to this relationship type"
                        exportFilename={`relationships-${type.toLowerCase()}`}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {addDialogOpen && selectedType && (
        <AddRelationshipDialog
          open={addDialogOpen}
          onOpenChange={setAddDialogOpen}
          itemId={itemId}
          relationshipType={selectedType}
          onSuccess={handleRelationshipAdded}
        />
      )}

      {newTypeDialogOpen && (
        <NewRelationshipTypeDialog
          open={newTypeDialogOpen}
          onOpenChange={setNewTypeDialogOpen}
          itemId={itemId}
          onSuccess={handleRelationshipAdded}
        />
      )}
    </>
  )
}
