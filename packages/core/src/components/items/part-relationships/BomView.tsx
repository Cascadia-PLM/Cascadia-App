// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useNavigate } from '@tanstack/react-router'
import {
  Download,
  ExternalLink,
  FolderTree,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import type { BOMTreeNode } from '@/components/bom/types'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import { Badge, Button, Card, CardContent } from '@/components/ui'
import { ContextMenuItem } from '@/components/ui/ContextMenu'
import { BomTreeView } from '@/components/bom/BomTreeView'
import { exportBomTreeToCsv } from '@/components/bom/exportBomTree'
import { StateBadge } from '@/components/items/StateBadge'
import { getItemDetailPath } from '@/lib/items/item-type-ui'

/**
 * The BOM structure tab: the assembly tree, in a grid layout.
 *
 * Owns its column definitions and its context menu, which nothing else reads.
 * Expansion state belongs to the panel — the tree should still be open where
 * the user left it after a trip to another tab.
 */
export function BomView({
  nodes: bomNodes,
  loading: bomLoading,
  expandedNodes: expandedBomNodes,
  onToggle: handleBomToggle,
  onRefresh,
}: {
  nodes: Array<BOMTreeNode>
  loading: boolean
  expandedNodes: Set<string>
  onToggle: (itemId: string) => void
  onRefresh: () => void
}) {
  const navigate = useNavigate()

  // BOM tree columns
  const bomColumns: Array<ColumnDefinition> = [
    {
      id: 'item',
      label: 'Item',
      width: 'flex-[2] min-w-[200px]',
      renderCell: (node) => (
        <span className="font-medium text-slate-900 dark:text-white truncate">
          {node.itemNumber}
        </span>
      ),
    },
    {
      id: 'name',
      label: 'Name',
      width: 'flex-[2] min-w-[150px]',
      renderCell: (node) => (
        <span className="truncate text-slate-600 dark:text-slate-400">
          {node.name}
        </span>
      ),
    },
    {
      id: 'type',
      label: 'Type',
      width: 'w-20 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <Badge variant="outline" className="text-xs">
          {node.itemType}
        </Badge>
      ),
    },
    {
      id: 'qty',
      label: 'Qty',
      width: 'w-14 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <span className="text-xs text-slate-500">{node.quantity ?? '—'}</span>
      ),
    },
    {
      id: 'findNum',
      label: 'Find #',
      width: 'w-14 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <span className="text-xs text-slate-500">{node.findNumber ?? '—'}</span>
      ),
    },
    {
      id: 'rev',
      label: 'Rev',
      width: 'w-14 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <span className="text-xs text-slate-500">{node.revision}</span>
      ),
    },
    {
      id: 'state',
      label: 'State',
      width: 'w-24 flex-shrink-0',
      align: 'center',
      renderCell: (node) => (
        <StateBadge
          itemType={node.itemType}
          state={node.state}
          className="text-xs"
        />
      ),
    },
  ]

  // BOM tree context menu
  const renderBomContextMenu = (node: BOMTreeNode) => {
    const route = getItemDetailPath(node.itemType, node.itemId)
    if (!route) return null
    return (
      <ContextMenuItem onClick={() => navigate({ to: route })}>
        <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
        View
      </ContextMenuItem>
    )
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {bomLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        ) : bomNodes.length === 0 ? (
          <div className="text-center py-8">
            <FolderTree className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
            <p className="text-slate-500 dark:text-slate-400">
              No BOM structure found
            </p>
            <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
              Add BOM relationships to see the hierarchy
            </p>
          </div>
        ) : (
          <>
            <BomTreeView
              nodes={bomNodes}
              expandedNodes={expandedBomNodes}
              onToggle={handleBomToggle}
              layout="grid"
              columns={bomColumns}
              renderContextMenu={renderBomContextMenu}
            />
            <div className="mt-4 flex items-center justify-between">
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Showing BOM hierarchy with direct children
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    exportBomTreeToCsv(bomNodes, {
                      filename: 'bom-structure',
                    })
                  }
                >
                  <Download className="h-4 w-4 mr-1" />
                  Export CSV
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onRefresh}
                  disabled={bomLoading}
                >
                  <RefreshCw className="h-4 w-4 mr-1" />
                  Refresh
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
