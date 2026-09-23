// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Lock } from 'lucide-react'
import { cn } from '@/utils'

/**
 * Says that a BOM tree on screen is missing what its viewer cannot read.
 *
 * The structure reads withhold an item from a program the viewer cannot open,
 * together with everything beneath it, and send one `hasRestricted` flag in
 * its place. The one thing this notice must not do is stay quiet: a tree that
 * is silently a line short reads as the whole BOM, and gets reviewed, exported
 * and built as one. It says that, and nothing else — no count and no program,
 * both of which were withheld on purpose.
 */
export function RestrictedStructureNotice({
  className,
}: {
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-900/20 dark:text-amber-200',
        className,
      )}
      data-testid="structure-restricted-notice"
    >
      <Lock className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        Part of this structure is in programs you do not have access to. Those
        items, and everything under them, are not shown here and are left out of
        anything exported from it. Ask your administrator for access to the
        other programs this structure uses.
      </span>
    </div>
  )
}
