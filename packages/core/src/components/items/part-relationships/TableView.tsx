// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useMemo } from 'react'
import {
  ChevronDown,
  ExternalLink,
  Pencil,
  Plus,
  Table as TableIcon,
  Trash2,
} from 'lucide-react'
import type { Row } from '@tanstack/react-table'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import type { Relationship } from './types'
import { Badge, Button, Card, CardContent } from '@/components/ui'
import { DataGrid } from '@/components/ui/DataGrid'
import { ContextMenuItem } from '@/components/ui/ContextMenu'
import { ItemLink } from '@/components/items/ItemLink'
import { StateBadge } from '@/components/items/StateBadge'
import { getItemDetailPath } from '@/lib/items/item-type-ui'

/**
 * The relationships table: one collapsible DataGrid per relationship type.
 *
 * Owns its column definitions and filter options, which nothing outside it
 * reads. Selection, editing and removal are the panel's — they open dialogs
 * the panel renders — so they arrive as callbacks.
 */
export function TableView({
  grouped,
  relationships,
  readOnly,
  collapsedTypes,
  onToggleType,
  onAddToType,
  onAddNewType,
  onEdit,
  onRemove,
}: {
  grouped: Record<string, Array<Relationship>>
  relationships: Array<Relationship>
  readOnly: boolean
  collapsedTypes: Set<string>
  onToggleType: (type: string) => void
  onAddToType: (type: string) => void
  onAddNewType: () => void
  onEdit: (relationship: Relationship) => void
  onRemove: (relationshipId: string) => void
}) {
  const isTypeExpanded = (type: string) => !collapsedTypes.has(type)
  const toggleType = onToggleType
  const handleAddToExistingType = onAddToType
  const setEditingRelationship = onEdit
  const handleRemoveRelationship = onRemove
  const groupedRelationships = grouped

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

  // Get URL for relationship row
  const getRowUrl = useCallback(
    (row: Relationship) =>
      getItemDetailPath(row.targetItem.itemType, row.targetItem.id) ??
      undefined,
    [],
  )

  // Context menu items
  const renderContextMenuItems = useCallback(
    (row: Row<Relationship>) => {
      if (readOnly) return null
      return (
        <>
          <ContextMenuItem onClick={() => setEditingRelationship(row.original)}>
            <Pencil className="mr-2 h-4 w-4" />
            Edit
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => handleRemoveRelationship(row.original.id)}
            className="text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400"
          >
            <Trash2 className="mr-2 h-4 w-4" />
            Remove
          </ContextMenuItem>
        </>
      )
    },
    [readOnly],
  )

  // Table columns
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
          return (
            <ItemLink
              itemType={rel.targetItem.itemType}
              itemId={rel.targetItem.id}
              className="font-medium text-cyan-600 dark:text-cyan-400 hover:text-cyan-700 dark:hover:text-cyan-300 hover:underline flex items-center gap-1"
            >
              {rel.targetItem.itemNumber}
              <ExternalLink className="h-3 w-3" />
            </ItemLink>
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
        cell: ({ row, getValue }) => (
          <StateBadge
            itemType={row.original.targetItem.itemType}
            state={getValue() as string}
            className="text-xs"
          />
        ),
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
        meta: { width: '80px', align: 'center' as const },
        cell: ({ row }) => {
          if (readOnly) return null
          return (
            <div className="flex items-center justify-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setEditingRelationship(row.original)}
                className="h-8 w-8 p-0"
                aria-label="Edit relationship"
              >
                <Pencil className="h-4 w-4 text-slate-600 dark:text-slate-400" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => handleRemoveRelationship(row.original.id)}
                className="h-8 w-8 p-0"
                aria-label="Remove relationship"
              >
                <Trash2 className="h-4 w-4 text-red-600 dark:text-red-400" />
              </Button>
            </div>
          )
        },
      },
    ],
    [stateOptions, itemTypeOptions, readOnly],
  )

  return (
    <Card>
      <CardContent className="pt-6">
        {Object.keys(groupedRelationships).length === 0 ? (
          <div className="text-center py-8">
            <TableIcon className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
            <p className="text-slate-500 dark:text-slate-400 mb-4">
              No relationships yet
            </p>
            {!readOnly && (
              <Button variant="outline" size="sm" onClick={onAddNewType}>
                <Plus className="h-4 w-4 mr-1" />
                Add First Relationship
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {Object.entries(groupedRelationships).map(([type, rels]) => (
              <div key={type} className="border rounded-lg overflow-hidden">
                <div className="bg-slate-50 dark:bg-slate-900 px-4 py-3 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => toggleType(type)}
                    className="flex items-center gap-2 text-sm font-medium hover:text-cyan-600 dark:hover:text-cyan-400 transition-colors"
                  >
                    <div
                      className={`chevron-rotate ${isTypeExpanded(type) ? 'chevron-rotate-down' : 'chevron-rotate-right'}`}
                    >
                      <ChevronDown className="h-4 w-4" />
                    </div>
                    {type}
                    <Badge variant="secondary" className="animate-badge-pulse">
                      {rels.length}
                    </Badge>
                  </button>
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleAddToExistingType(type)}
                    >
                      <Plus className="h-4 w-4 mr-1" />
                      Add
                    </Button>
                  )}
                </div>

                {isTypeExpanded(type) && (
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
  )
}
