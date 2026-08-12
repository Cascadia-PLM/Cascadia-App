// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { SourceDiffDialog } from './SourceDiffDialog'
import type { SourceDiffTarget } from './SourceDiffDialog'
import { Badge } from '@/components/ui'

interface SourceFieldChange {
  fieldName: string // 'added' | 'modified' | 'deleted'
  fieldPath?: string
  oldValue: unknown // { hash, size } | null
  newValue: unknown // { hash, size } | null
}

const statusVariant: Record<
  string,
  'default' | 'success' | 'destructive' | 'secondary'
> = {
  added: 'success',
  modified: 'default',
  deleted: 'destructive',
}

function hashOf(value: unknown): string | null {
  if (value && typeof value === 'object' && 'hash' in value) {
    return String(value.hash)
  }
  return null
}

/**
 * Renders 'source'-category field changes (per-file source-tree history rows
 * on Software items) with click-through to a side-by-side line diff.
 */
export function SourceChangesList({
  itemId,
  changes,
}: {
  itemId: string
  changes: Array<SourceFieldChange>
}) {
  const [diffTarget, setDiffTarget] = useState<SourceDiffTarget | null>(null)

  return (
    <div className="space-y-1">
      {changes.map((change, idx) => {
        const oldHash = hashOf(change.oldValue)
        const newHash = hashOf(change.newValue)
        return (
          <button
            key={idx}
            type="button"
            onClick={() =>
              setDiffTarget({
                itemId,
                path: change.fieldPath ?? '',
                oldHash,
                newHash,
                oldLabel: 'Previous',
                newLabel: 'This commit',
              })
            }
            className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
            title="Show line diff"
          >
            <Badge
              variant={statusVariant[change.fieldName] ?? 'secondary'}
              className="w-20 justify-center text-xs"
            >
              {change.fieldName}
            </Badge>
            <span className="truncate font-mono text-slate-700 dark:text-slate-300">
              {change.fieldPath}
            </span>
          </button>
        )
      })}
      <SourceDiffDialog
        target={diffTarget}
        onClose={() => setDiffTarget(null)}
      />
    </div>
  )
}
