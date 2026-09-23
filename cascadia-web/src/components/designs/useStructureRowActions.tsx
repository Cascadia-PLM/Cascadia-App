// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Fragment } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import {
  ArrowDownToLine,
  ExternalLink,
  Link2Off,
  ListMinus,
  MoreVertical,
  Plus,
  Trash2,
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Row } from '@tanstack/react-table'
import type { BOMTreeNode } from '@/components/bom/types'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import type { VersionContext } from '@/hooks/useVersionContext'
import { Button } from '@/components/ui'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { apiFetch } from '@/api/client'
import { useAlertDialog } from '@/hooks/useAlertDialog'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { usePermission } from '@/hooks/usePermissions'
import { getItemDetailPath } from '@/items/item-type-ui'
import { designStatusQuery, useResourceMutation } from '@/query'

/**
 * An item that belongs to the design but sits outside the BOM hierarchy — a
 * document, a requirement, or a part that no root reaches.
 */
export interface NonStructureItem {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  itemType: string
}

interface RowAction {
  label: string
  icon: LucideIcon
  onSelect: () => void
  /** Drawn in red: something leaves the structure, or the design. */
  destructive?: boolean
}

/**
 * A row's actions in the order both of its menus show them — where the item
 * lives, what can be done to it here, and how it leaves — with a separator
 * between the groups that have anything in them.
 */
type RowActionGroups = Array<Array<RowAction>>

const DESTRUCTIVE_ITEM =
  'text-red-600 dark:text-red-400 focus:text-red-600 dark:focus:text-red-400'

function contextMenuItems(groups: RowActionGroups): ReactNode {
  const filled = groups.filter((group) => group.length > 0)
  if (filled.length === 0) return null
  return filled.map((group, index) => (
    <Fragment key={index}>
      {index > 0 && <ContextMenuSeparator />}
      {group.map((action) => (
        <ContextMenuItem
          key={action.label}
          onClick={action.onSelect}
          className={action.destructive ? DESTRUCTIVE_ITEM : undefined}
        >
          <action.icon className="mr-1.5 h-3.5 w-3.5" />
          {action.label}
        </ContextMenuItem>
      ))}
    </Fragment>
  ))
}

/**
 * The same actions behind a button that is on screen. A right-click menu is
 * invisible until someone thinks to try one: the tree's removals lived only
 * there, and were reported as not existing.
 */
function RowActionsMenu({
  groups,
  label,
}: {
  groups: RowActionGroups
  label: string
}) {
  const filled = groups.filter((group) => group.length > 0)
  if (filled.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          className="h-6 w-6 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
        >
          <MoreVertical className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {filled.map((group, index) => (
          <Fragment key={index}>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map((action) => (
              <DropdownMenuItem
                key={action.label}
                onClick={action.onSelect}
                className={action.destructive ? DESTRUCTIVE_ITEM : undefined}
              >
                <action.icon className="mr-1.5 h-3.5 w-3.5" />
                {action.label}
              </DropdownMenuItem>
            ))}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface UseStructureRowActionsOptions {
  designId: string
  designCode: string
  versionContext: VersionContext
  isHistoricalView: boolean
  /** Open Add Child under this node. */
  onAddChild: (node: BOMTreeNode) => void
  /** Open the pull-in dialog for an external or referenced node. */
  onPullIn: (node: BOMTreeNode) => void
}

/**
 * What each row of the Structure tab offers, and the writes behind it: the
 * right-click menus of the tree and of Non-Structure Items, and the visible
 * menus that repeat them.
 *
 * Three of the actions take something out, and they are not the same act:
 *
 * - **Remove from Structure** takes a root part out of the tree. The part
 *   stays in the design, listed with the non-structure items.
 * - **Remove Reference** drops a cross-design reference. The part it names
 *   belongs to another design and is not touched.
 * - **Delete Part** deletes a part of this design — the hard delete, BOM
 *   lines and all.
 */
export function useStructureRowActions({
  designId,
  designCode,
  versionContext,
  isHistoricalView,
  onAddChild,
  onPullIn,
}: UseStructureRowActionsOptions) {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()

  // Delete Part is offered only where the delete behind it can succeed: the
  // page on main, main unprotected — nothing released yet — and a user who
  // holds parts:delete. Once a design has a release behind it, a part leaves
  // on a change-order branch, where the deletion is recorded rather than
  // done, and that is not this. The server enforces every condition
  // regardless; this decides only what the menus show.
  const { data: status } = useQuery(designStatusQuery(designId))
  const { allowed: mayDeleteParts } = usePermission('parts', 'delete')
  const canDeleteParts =
    versionContext.type === 'main' &&
    status?.protection.isMainBranchProtected === false &&
    mayDeleteParts

  // Clears inDesignStructure and keeps the designId: the part moves to
  // Non-Structure Items. Only root parts (no relationshipId) get here; a
  // child leaves the tree through its parent's BOM.
  const removeFromStructure = useResourceMutation({
    mutationFn: (itemId: string) =>
      apiFetch(`/api/v1/designs/${designId}/items?itemId=${itemId}`, {
        method: 'DELETE',
      }),
    invalidates: ['designs'],
    onError: (error: Error) =>
      handleError(error, { title: 'Failed to remove from structure' }),
  })

  // Sets inDesignStructure: a non-structure part becomes a root.
  const addToStructure = useResourceMutation({
    mutationFn: (itemId: string) =>
      apiFetch(`/api/v1/designs/${designId}/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId }),
      }),
    invalidates: ['designs'],
    onError: (error: Error) =>
      handleError(error, { title: 'Failed to add to structure' }),
  })

  // The part itself, not its place in the tree. Named 'parts' so the parts
  // lists refresh as well; the tree follows through 'relationships'.
  const deletePart = useResourceMutation({
    mutationFn: (part: { id: string; itemNumber: string }) =>
      apiFetch(`/api/v1/parts/${part.id}`, { method: 'DELETE' }),
    invalidates: ['parts'],
    onSuccess: (_data, part) =>
      showSuccess('Part deleted', `${part.itemNumber} has been deleted`),
    onError: (error: Error) =>
      handleError(error, { title: 'Failed to delete part' }),
  })

  // A reference is a row of its own, so removing one leaves the part it names
  // alone. On a branch the endpoint keeps the removal to that branch: main's
  // row stays until the branch is released.
  const removeReference = useResourceMutation({
    mutationFn: (referenceId: string) => {
      const params = new URLSearchParams({ refId: referenceId })
      if (versionContext.branchId) params.set('branch', versionContext.branchId)
      return apiFetch(
        `/api/v1/designs/${designId}/cross-references?${params}`,
        { method: 'DELETE' },
      )
    },
    invalidates: ['designs'],
    onError: (error: Error) =>
      handleError(error, { title: 'Failed to remove reference' }),
  })

  const confirmRemoveFromStructure = (node: BOMTreeNode) =>
    confirm({
      title: 'Remove from Structure',
      description: `Are you sure you want to remove ${node.itemNumber} from the design structure? The part will move to Non-Structure Items but will still belong to this design.`,
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: () => removeFromStructure.mutate(node.itemId),
    })

  const confirmAddToStructure = (item: NonStructureItem) =>
    confirm({
      title: 'Add to Structure',
      description: `Add ${item.itemNumber} to the design structure as a top-level part?`,
      actionLabel: 'Add',
      cancelLabel: 'Cancel',
      onConfirm: () => addToStructure.mutate(item.id),
    })

  const confirmDeletePart = (part: { id: string; itemNumber: string }) =>
    confirm({
      title: 'Delete Part',
      description: `Permanently delete ${part.itemNumber} from ${designCode}? Assemblies that use it lose that BOM line, and parts under it stay in the design. This cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: () => deletePart.mutate(part),
    })

  const confirmRemoveReference = (node: BOMTreeNode, referenceId: string) =>
    confirm({
      title: 'Remove Reference',
      description: `Remove the reference to ${node.itemNumber} from ${designCode}? The part stays in ${node.designCode ?? 'its own design'}; only this design's link to it is removed.`,
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: () => removeReference.mutate(referenceId),
    })

  const nodeActions = (node: BOMTreeNode): RowActionGroups => {
    // Another design's part, reached through a BOM line or a reference:
    // viewable and pullable, but not this design's to edit or remove.
    const foreign = Boolean(node.isExternal || node.isCrossDesignRef)
    const route = getItemDetailPath(node.itemType, node.itemId)
    const view: Array<RowAction> = route
      ? [
          {
            label: foreign ? 'View in Home Design' : 'View',
            icon: ExternalLink,
            onSelect: () => void navigate({ to: route }),
          },
        ]
      : []
    if (isHistoricalView) return [view]

    const edit: Array<RowAction> = foreign
      ? [
          {
            label: 'Pull In as Usage Copy',
            icon: ArrowDownToLine,
            onSelect: () => onPullIn(node),
          },
        ]
      : node.itemType === 'Part'
        ? [{ label: 'Add Child', icon: Plus, onSelect: () => onAddChild(node) }]
        : []

    const remove: Array<RowAction> = []
    if (!foreign && !node.relationshipId) {
      remove.push({
        label: 'Remove from Structure',
        icon: ListMinus,
        destructive: true,
        onSelect: () => confirmRemoveFromStructure(node),
      })
    }
    const referenceId = node.isCrossDesignRef
      ? node.crossReferenceId
      : undefined
    if (referenceId) {
      remove.push({
        label: 'Remove Reference',
        icon: Link2Off,
        destructive: true,
        onSelect: () => confirmRemoveReference(node, referenceId),
      })
    }
    if (!foreign && node.itemType === 'Part' && canDeleteParts) {
      remove.push({
        label: 'Delete Part',
        icon: Trash2,
        destructive: true,
        onSelect: () =>
          confirmDeletePart({ id: node.itemId, itemNumber: node.itemNumber }),
      })
    }

    return [view, edit, remove]
  }

  // Only parts can rejoin the BOM — documents and requirements stay out of it.
  const nonStructureActions = (item: NonStructureItem): RowActionGroups => {
    if (isHistoricalView || item.itemType !== 'Part') return []
    return [
      [
        {
          label: 'Add to Structure',
          icon: Plus,
          onSelect: () => confirmAddToStructure(item),
        },
      ],
      canDeleteParts
        ? [
            {
              label: 'Delete Part',
              icon: Trash2,
              destructive: true,
              onSelect: () => confirmDeletePart(item),
            },
          ]
        : [],
    ]
  }

  // Which non-structure row is mid-add, for its button's label. The
  // mutation's own `variables` stays set until the invalidation settles.
  const addingItemId = addToStructure.isPending
    ? addToStructure.variables
    : undefined

  // The tree's trailing column: each row's menu, on screen. Built per render
  // rather than memoized, because what a row offers moves with the design's
  // status and the page's version context.
  const menuColumn: ColumnDefinition = {
    id: 'actions',
    label: '',
    width: 'w-8 flex-shrink-0',
    align: 'center',
    renderCell: (node) => (
      <RowActionsMenu
        groups={nodeActions(node)}
        label={`Actions for ${node.itemNumber}`}
      />
    ),
  }

  return {
    renderNodeContextMenu: (node: BOMTreeNode) =>
      contextMenuItems(nodeActions(node)),
    menuColumn,
    renderNonStructureContextMenu: (row: Row<NonStructureItem>) =>
      contextMenuItems(nonStructureActions(row.original)),
    renderNonStructureRowActions: (row: Row<NonStructureItem>) => {
      const item = row.original
      const groups = nonStructureActions(item)
      if (groups.length === 0) return null
      return (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-950"
            onClick={() => confirmAddToStructure(item)}
            disabled={addingItemId === item.id}
          >
            <Plus className="h-3 w-3 mr-1" />
            {addingItemId === item.id ? 'Adding...' : 'Add to Structure'}
          </Button>
          <RowActionsMenu
            groups={groups}
            label={`Actions for ${item.itemNumber}`}
          />
        </div>
      )
    },
  }
}
