// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowUpFromLine,
  FolderTree,
  GitBranch,
  Loader2,
  Plus,
  Table as TableIcon,
} from 'lucide-react'
import { AddRelationshipDialog } from './AddRelationshipDialog'
import { EditRelationshipDialog } from './EditRelationshipDialog'
import { NewRelationshipTypeDialog } from './NewRelationshipTypeDialog'
import { BomView } from './part-relationships/BomView'
import { GraphView } from './part-relationships/GraphView'
import { TableView } from './part-relationships/TableView'
import { WhereUsedView } from './part-relationships/WhereUsedView'
import { useRelationshipGraph } from './part-relationships/useRelationshipGraph'
import type {
  ItemUsageInfo,
  Relationship,
  ViewMode,
  WhereUsedNode,
} from './part-relationships/types'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useTheme } from '@/lib/theme'
import { apiFetch } from '@/lib/api/client'
import { entityQuery, useInvalidateResources } from '@/lib/query'
import {
  itemBomTreeQuery,
  itemRelationshipsQuery,
  itemWhereUsedQuery,
} from '@/lib/query/options/relationships'

interface PartRelationshipsPanelProps {
  itemId: string
  itemType: string
  branchId?: string
  /**
   * Hide add/remove affordances. Relationship changes are content edits of
   * the item, so they follow the click-Edit (checkout) policy — the parent
   * passes readOnly until the user holds the edit lock. The server enforces
   * the same rule regardless.
   */
  readOnly?: boolean
}

/**
 * An item's relationships, in four views.
 *
 * The container owns what outlives a tab switch: which view is showing, the
 * shared relationship list, each view's expansion state, and the three
 * dialogs. Radix unmounts an inactive `TabsContent`, so anything a view is
 * expected to remember has to be held here — that is why `useRelationshipGraph`
 * is a hook called at this level rather than state inside `GraphView`, and why
 * the BOM tree's open rows and the table's collapsed types live here too.
 *
 * Each view's own machinery — column definitions, filter options, layout —
 * belongs to the view. See `part-relationships/`.
 */
export function PartRelationshipsPanel({
  itemId,
  branchId,
  readOnly = false,
}: PartRelationshipsPanelProps) {
  const { theme } = useTheme()
  const { alert, confirm } = useAlertDialog()
  const invalidate = useInvalidateResources()
  const [activeView, setActiveView] = useState<ViewMode>('bom')

  // Shared relationship data
  const { data: relationships = [], isPending: loading } = useQuery(
    itemRelationshipsQuery<Relationship>(itemId, { branchId }),
  )
  const { data: itemUsage } = useQuery(
    entityQuery<ItemUsageInfo>('items', itemId, 'item'),
  )

  // Dialog state
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [newTypeDialogOpen, setNewTypeDialogOpen] = useState(false)
  const [selectedType, setSelectedType] = useState<string | null>(null)
  const [editingRelationship, setEditingRelationship] =
    useState<Relationship | null>(null)

  // Table view: every type is expanded by default, so this holds the ones the
  // user closed by hand.
  const [collapsedTypes, setCollapsedTypes] = useState<Set<string>>(new Set())

  // BOM view: the root is open from the start, everything below it closed.
  const [expandedBomNodes, setExpandedBomNodes] = useState<Set<string>>(
    () => new Set([itemId]),
  )

  const whereUsedQuery = useQuery(
    itemWhereUsedQuery<WhereUsedNode>(itemId, activeView === 'where-used'),
  )
  const bomQuery = useQuery(
    itemBomTreeQuery(itemId, branchId, activeView === 'bom'),
  )
  const graph = useRelationshipGraph({
    itemId,
    branchId,
    enabled: activeView === 'graph',
    relationships,
    itemUsage,
  })

  const groupedRelationships = relationships.reduce(
    (acc, rel) => {
      ;(acc[rel.relationshipType] ??= []).push(rel)
      return acc
    },
    {} as Record<string, Array<Relationship>>,
  )

  const toggleType = (type: string) => {
    setCollapsedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(type)) {
        next.delete(type)
      } else {
        next.add(type)
      }
      return next
    })
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
          await apiFetch(`/api/v1/relationships/${relationshipId}`, {
            method: 'DELETE',
          })
          await invalidate('relationships')
        } catch (error) {
          alert({
            title: 'Failed to remove relationship',
            description:
              error instanceof Error
                ? error.message
                : 'Failed to remove relationship',
            variant: 'destructive',
          })
        }
      },
    })
  }

  const handleRelationshipAdded = () => {
    setAddDialogOpen(false)
    setNewTypeDialogOpen(false)
  }

  const handleBomToggle = (nodeItemId: string) => {
    setExpandedBomNodes((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(nodeItemId)) {
        newSet.delete(nodeItemId)
      } else {
        newSet.add(nodeItemId)
      }
      return newSet
    })
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <div className="space-y-4">
        {/* Header with count badges */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
              Relationships
            </h2>
            <Badge variant="outline">
              {relationships.length} relationship
              {relationships.length !== 1 ? 's' : ''}
            </Badge>
            <Badge variant="outline">
              {Object.keys(groupedRelationships).length} type
              {Object.keys(groupedRelationships).length !== 1 ? 's' : ''}
            </Badge>
          </div>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={handleAddNewType}>
              <Plus className="h-4 w-4 mr-1" />
              Add Relationship
            </Button>
          )}
        </div>

        <Tabs
          value={activeView}
          onValueChange={(v) => setActiveView(v as ViewMode)}
        >
          <TabsList>
            <TabsTrigger value="bom" className="gap-2">
              <FolderTree className="h-4 w-4" />
              BOM Structure
            </TabsTrigger>
            <TabsTrigger value="graph" className="gap-2">
              <GitBranch className="h-4 w-4" />
              Graph View
            </TabsTrigger>
            <TabsTrigger value="table" className="gap-2">
              <TableIcon className="h-4 w-4" />
              Table View
            </TabsTrigger>
            <TabsTrigger value="where-used" className="gap-2">
              <ArrowUpFromLine className="h-4 w-4" />
              Where Used
            </TabsTrigger>
          </TabsList>

          <TabsContent value="bom" className="mt-4">
            <BomView
              nodes={bomQuery.data ?? []}
              loading={bomQuery.isPending || bomQuery.isFetching}
              expandedNodes={expandedBomNodes}
              onToggle={handleBomToggle}
              onRefresh={() => void bomQuery.refetch()}
            />
          </TabsContent>

          <TabsContent value="graph" className="mt-4">
            <GraphView graph={graph} theme={theme} />
          </TabsContent>

          <TabsContent value="table" className="mt-4">
            <TableView
              grouped={groupedRelationships}
              relationships={relationships}
              readOnly={readOnly}
              collapsedTypes={collapsedTypes}
              onToggleType={toggleType}
              onAddToType={handleAddToExistingType}
              onAddNewType={handleAddNewType}
              onEdit={setEditingRelationship}
              onRemove={handleRemoveRelationship}
            />
          </TabsContent>

          <TabsContent value="where-used" className="mt-4">
            <WhereUsedView
              nodes={whereUsedQuery.data ?? []}
              loading={whereUsedQuery.isPending || whereUsedQuery.isFetching}
            />
          </TabsContent>
        </Tabs>
      </div>

      {/* Dialogs */}
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

      {editingRelationship && (
        <EditRelationshipDialog
          open
          onOpenChange={(open) => {
            if (!open) setEditingRelationship(null)
          }}
          relationship={editingRelationship}
        />
      )}
    </>
  )
}
