// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Loader2 } from 'lucide-react'
import type { WhereUsedNode } from './types'
import { Badge, Card, CardContent } from '@/components/ui'
import { ItemLink } from '@/components/items/ItemLink'
import { StateBadge } from '@/components/items/StateBadge'

/**
 * The where-used tab: every assembly this item appears in, by depth.
 *
 * A flat table with no state of its own — the query lives in the panel, gated
 * on the tab being open.
 */
export function WhereUsedView({
  nodes: whereUsedData,
  loading: whereUsedLoading,
}: {
  nodes: Array<WhereUsedNode>
  loading: boolean
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        {whereUsedLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">
              Loading where-used data...
            </span>
          </div>
        ) : whereUsedData.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            This item is not used in any assemblies.
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground mb-4">
              Found in {whereUsedData.length} parent assembl
              {whereUsedData.length === 1 ? 'y' : 'ies'}
            </p>
            <div className="border rounded-md">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="text-left p-3 font-medium">Item Number</th>
                    <th className="text-left p-3 font-medium">Name</th>
                    <th className="text-left p-3 font-medium">Type</th>
                    <th className="text-left p-3 font-medium">Rev</th>
                    <th className="text-left p-3 font-medium">State</th>
                    <th className="text-left p-3 font-medium">Depth</th>
                    <th className="text-left p-3 font-medium">Design</th>
                  </tr>
                </thead>
                <tbody>
                  {whereUsedData.map((node) => (
                    <tr
                      key={`${node.itemId}-${node.depth}`}
                      className="border-b last:border-b-0 hover:bg-muted/30"
                    >
                      <td className="p-3">
                        <ItemLink
                          itemType={node.itemType}
                          itemId={node.itemId}
                          className="text-blue-600 dark:text-blue-400 hover:underline font-mono text-xs"
                        >
                          {node.itemNumber}
                        </ItemLink>
                      </td>
                      <td className="p-3">{node.name}</td>
                      <td className="p-3">
                        <Badge variant="outline">{node.itemType}</Badge>
                      </td>
                      <td className="p-3 font-mono text-xs">{node.revision}</td>
                      <td className="p-3">
                        <StateBadge
                          itemType={node.itemType}
                          state={node.state}
                        />
                      </td>
                      <td className="p-3 text-muted-foreground">
                        {node.depth}
                      </td>
                      <td className="p-3 text-muted-foreground text-xs">
                        {node.designName ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
