// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Factory, Save } from 'lucide-react'
import { OptionConditionChips } from './OptionConditionChips'
import type { ColumnDefinition } from '@/components/bom/BomTreeView'
import type { BOMTreeNode } from '@/components/bom/types'
import type { Make, OptionModel } from '@/lib/types/variants'
import type { ResolvedBomNode } from '@/lib/query'
import {
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import { BomTreeView } from '@/components/bom/BomTreeView'
import { StateBadge } from '@/components/items/StateBadge'
import { partVariantResolveQuery } from '@/lib/query'

/**
 * Pick a value per option family and watch the 100 % BOM it resolves to.
 * Selections live in the tab so a make can be loaded into them and the
 * current ones saved as a make.
 */
export function PartConfigurator({
  partId,
  model,
  selections,
  onSelectionsChange,
  branchId,
  makes,
  onSaveAsMake,
  onCreateMbom,
}: {
  partId: string
  model: OptionModel
  selections: Record<string, string>
  onSelectionsChange: (next: Record<string, string>) => void
  branchId?: string
  makes: Array<Make>
  /** Absent when the page is not in edit mode. */
  onSaveAsMake?: (make: Make) => void
  /** Absent until the MBOM route accepts a configuration. */
  onCreateMbom?: (selections: Record<string, string>) => void
}) {
  const hasSelection = Object.keys(selections).length > 0
  const resolved = useQuery(
    partVariantResolveQuery(partId, selections, branchId, hasSelection),
  )

  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [makeCode, setMakeCode] = useState('')
  const [makeName, setMakeName] = useState('')

  const nodes = useMemo<Array<BOMTreeNode>>(() => {
    const toNode = (n: ResolvedBomNode): BOMTreeNode => ({
      itemId: n.itemId,
      masterId: n.masterId,
      itemNumber: n.itemNumber,
      name: n.name,
      revision: n.revision,
      state: n.state,
      itemType: n.itemType,
      designId: n.designId,
      quantity: n.quantity ?? undefined,
      findNumber: n.findNumber ?? undefined,
      relationshipId: n.relationshipId,
      option: n.admittedBy,
      children: n.children.length ? n.children.map(toNode) : undefined,
    })
    return (resolved.data?.children ?? []).map(toNode)
  }, [resolved.data])

  // Everything open: a resolved BOM is small and the point is to see it.
  const allIds = useMemo(() => {
    const ids = new Set<string>()
    const collect = (list: Array<BOMTreeNode>) => {
      for (const n of list) {
        ids.add(n.itemId)
        if (n.children) collect(n.children)
      }
    }
    collect(nodes)
    return ids
  }, [nodes])
  const expandedNodes = expanded.size > 0 ? expanded : allIds

  const columns: Array<ColumnDefinition> = [
    {
      id: 'item',
      label: 'Item',
      width: 'flex-[2] min-w-[180px]',
      renderCell: (node) => (
        <span className="font-medium text-slate-900 dark:text-white truncate">
          {node.itemNumber}
        </span>
      ),
    },
    {
      id: 'name',
      label: 'Name',
      width: 'flex-[2] min-w-[140px]',
      renderCell: (node) => (
        <span className="truncate text-slate-600 dark:text-slate-400">
          {node.name}
        </span>
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
      id: 'admitted',
      label: 'Admitted by',
      width: 'w-44 flex-shrink-0',
      renderCell: (node) => (
        <OptionConditionChips
          condition={node.option}
          model={model}
          fixedLabel="fixed"
        />
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

  const validation = resolved.data?.validation
  const matchingMake = makes.find(
    (m) =>
      Object.keys(m.selections).length === Object.keys(selections).length &&
      Object.entries(m.selections).every(([k, v]) => selections[k] === v),
  )
  const canSave =
    Boolean(onSaveAsMake) &&
    validation?.valid === true &&
    makeCode.trim().length > 0 &&
    !makes.some((m) => m.code.toLowerCase() === makeCode.trim().toLowerCase())

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {model.families.map((family) => (
          <div key={family.code}>
            <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">
              {family.name}
              {family.required && <span className="text-red-500"> *</span>}
            </div>
            <Select
              value={selections[family.code] ?? ''}
              onValueChange={(v) =>
                onSelectionsChange({ ...selections, [family.code]: v })
              }
            >
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {family.values.map((v) => (
                  <SelectItem key={v.code} value={v.code}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      {validation &&
        (validation.errors.length > 0 || validation.warnings.length > 0) && (
          <ul className="space-y-1">
            {[...validation.errors, ...validation.warnings].map((issue, i) => (
              <li
                key={i}
                className={`flex items-center gap-2 text-sm ${issue.severity === 'error' ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400'}`}
              >
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                {issue.message}
              </li>
            ))}
          </ul>
        )}

      {resolved.data && (
        <div className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
          <Badge variant={validation?.valid ? 'success' : 'warning'}>
            {validation?.valid ? 'Valid configuration' : 'Incomplete'}
          </Badge>
          <span>
            {resolved.data.droppedLines} line
            {resolved.data.droppedLines === 1 ? '' : 's'} not selected
          </span>
          {matchingMake && (
            <Badge variant="outline" className="font-mono">
              = {matchingMake.code}
            </Badge>
          )}
          {resolved.data.findings.map((f, i) => (
            <span key={i} className="text-amber-600 dark:text-amber-400">
              {f.itemNumber}: {f.message}
            </span>
          ))}
        </div>
      )}

      {hasSelection ? (
        <div className="rounded-md border border-slate-200 dark:border-slate-800">
          <BomTreeView
            nodes={nodes}
            expandedNodes={expandedNodes}
            onToggle={(id) =>
              setExpanded((prev) => {
                const next = new Set(prev.size > 0 ? prev : allIds)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }
            layout="grid"
            columns={columns}
            readOnly
          />
        </div>
      ) : (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Select options to preview the resolved BOM.
        </p>
      )}

      <div className="flex flex-wrap items-end gap-2">
        {onSaveAsMake && (
          <>
            <div>
              <div className="text-xs text-slate-500 mb-1">Make code</div>
              <Input
                className="h-8 w-28 text-sm font-mono"
                placeholder="MK1"
                value={makeCode}
                onChange={(e) => setMakeCode(e.target.value)}
              />
            </div>
            <div>
              <div className="text-xs text-slate-500 mb-1">Name</div>
              <Input
                className="h-8 w-40 text-sm"
                placeholder="Black"
                value={makeName}
                onChange={(e) => setMakeName(e.target.value)}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canSave}
              onClick={() => {
                onSaveAsMake({
                  code: makeCode.trim(),
                  name: makeName.trim(),
                  selections,
                  active: true,
                })
                setMakeCode('')
                setMakeName('')
              }}
            >
              <Save className="h-4 w-4 mr-1" />
              Save as make
            </Button>
          </>
        )}
        {onCreateMbom && (
          <Button
            type="button"
            size="sm"
            disabled={validation?.valid !== true}
            onClick={() => onCreateMbom(selections)}
          >
            <Factory className="h-4 w-4 mr-1" />
            Create MBOM
          </Button>
        )}
      </div>
    </div>
  )
}
