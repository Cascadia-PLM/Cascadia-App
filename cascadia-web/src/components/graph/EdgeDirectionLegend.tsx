// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { ArrowRight } from 'lucide-react'
import { GRAPH_EDGE_COLORS } from './edgeStyles'

/**
 * Legend row explaining how to read a relationship edge's direction. Shared by
 * the Part/Document relationship graph and the Program/Design scope graph so
 * the same sentence appears wherever directed edges are drawn.
 */
export function EdgeDirectionLegend({ example }: { example?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="inline-flex items-center gap-1">
        <span
          className="inline-block w-6 h-0 border-t-2"
          style={{ borderColor: GRAPH_EDGE_COLORS.relationship }}
        />
        <ArrowRight
          className="h-3.5 w-3.5"
          style={{ color: GRAPH_EDGE_COLORS.relationship }}
          aria-hidden
        />
      </span>
      <span>
        Arrows run from the item the relationship is stated on to the item it
        points at
        {example ? ` — ${example}` : ''}. The arrow beside a label points the
        same way; hover a label to read it in words.
      </span>
    </div>
  )
}
