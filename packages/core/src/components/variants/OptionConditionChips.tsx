// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { OptionCondition, OptionModel } from '@/lib/types/variants'
import { Badge } from '@/components/ui'

/**
 * A BOM line's option condition as chips, one per family. Labels come from
 * the model when one is given, codes otherwise. A fixed line renders nothing
 * unless asked to say so.
 */
export function OptionConditionChips({
  condition,
  model,
  fixedLabel,
  className,
}: {
  condition: OptionCondition | null | undefined
  model?: OptionModel | null
  /** Text to show for a fixed line; omit to render nothing. */
  fixedLabel?: string
  className?: string
}) {
  if (!condition) {
    return fixedLabel ? (
      <span className="text-xs text-slate-400 dark:text-slate-500">
        {fixedLabel}
      </span>
    ) : null
  }
  return (
    <span className={`inline-flex flex-wrap gap-1 ${className ?? ''}`}>
      {condition.all.map((entry) => {
        const family = model?.families.find((f) => f.code === entry.family)
        const values = entry.values
          .map((v) => family?.values.find((x) => x.code === v)?.label ?? v)
          .join(' / ')
        return (
          <Badge
            key={entry.family}
            variant="outline"
            className="text-xs font-normal whitespace-nowrap"
            title={`${entry.family} = ${entry.values.join(', ')}`}
          >
            <span className="text-slate-500 dark:text-slate-400 mr-1">
              {family?.name ?? entry.family}
            </span>
            {values}
          </Badge>
        )
      })}
    </span>
  )
}
