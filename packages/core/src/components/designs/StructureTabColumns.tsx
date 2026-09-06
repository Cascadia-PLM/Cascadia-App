// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo } from 'react'
import { Link2 } from 'lucide-react'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import type { BOMTreeNode } from '@/components/bom/types'
import { Badge } from '@/components/ui'
import { getStateBadgeVariant } from '@/components/bom/helpers'
import { OptionConditionChips } from '@/components/variants/OptionConditionChips'

/**
 * The design structure grid's columns. Extracted from `StructureTab` — the
 * editor is large and its columns are the one region nothing else in it
 * reads.
 *
 * The Option column (product variants) appears only when a line in the tree
 * carries a condition, so a design with no variants looks as it always did.
 */
export function useStructureColumns(
  isHistoricalView: boolean,
  roots: Array<BOMTreeNode>,
): Array<ColumnDefinition> {
  const showOption = useMemo(() => {
    const has = (list: Array<BOMTreeNode>): boolean =>
      list.some(
        (n) => Boolean(n.option) || (n.children ? has(n.children) : false),
      )
    return has(roots)
  }, [roots])

  return useMemo(
    () => {
      const columns: Array<ColumnDefinition> = [
        {
          id: 'item',
          label: 'Item',
          width: 'flex-[2] min-w-[200px]',
          renderCell: (node) => (
            <>
              <span
                className={`font-medium truncate ${
                  node.isCrossDesignRef
                    ? 'text-slate-500 dark:text-slate-400'
                    : 'text-slate-900 dark:text-white'
                }`}
              >
                {node.itemNumber}
              </span>
              {node.isCrossDesignRef && node.designCode && (
                <Badge
                  variant="outline"
                  className="text-xs text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600 flex-shrink-0"
                  title={`Cross-design reference from ${node.designName || node.designCode}`}
                >
                  XREF {node.designCode}
                </Badge>
              )}
              {!node.isCrossDesignRef && node.isExternal && node.designCode && (
                <Badge
                  variant="outline"
                  className="text-xs text-amber-600 dark:text-amber-400 border-amber-300 dark:border-amber-600 flex-shrink-0"
                  title={`From ${node.designName || node.designCode}`}
                >
                  <Link2 className="h-3 w-3 mr-1" />
                  {node.designCode}
                </Badge>
              )}
            </>
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
            <span className="text-xs text-slate-500">
              {node.quantity ?? '—'}
            </span>
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
            <Badge
              variant={getStateBadgeVariant(node.state)}
              className="text-xs"
            >
              {node.state}
            </Badge>
          ),
        },
        {
          id: 'inwork',
          label: '',
          width: 'w-6 flex-shrink-0',
          align: 'center',
          renderCell: (node) =>
            node.isInWork ? (
              <span className="text-amber-500" title="In work on ECO">
                &#8635;
              </span>
            ) : null,
        },
      ]
      if (showOption) {
        columns.splice(4, 0, {
          id: 'option',
          label: 'Option',
          width: 'w-40 flex-shrink-0',
          renderCell: (node) => (
            <OptionConditionChips
              condition={node.option}
              fixedLabel={node.relationshipId ? 'fixed' : undefined}
            />
          ),
        })
      }
      return columns
    },
    // isHistoricalView was the original memo key; the columns read it lazily.
    [isHistoricalView, showOption],
  )
}
