// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useNavigate } from '@tanstack/react-router'
import {
  Copy,
  ExternalLink,
  HelpCircle,
  Link2,
  MousePointerClick,
} from 'lucide-react'
import type { CADSelectionState } from './useCADSelectionState'
import type { CadModelNode } from '@cascadia/commons/lib/vault/cad-nodes'
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu'
import { StateBadge } from '@/components/items/StateBadge'
import { getItemDetailPath } from '@/lib/items/item-type-ui'

/**
 * What the selected part of an assembly is, and what can be done with it.
 *
 * Two overlays over one selection: a caption naming the part, and the
 * right-click menu acting on it. They are together because they answer the
 * same question — "what is this thing I just clicked" — and apart from the
 * viewer because neither is about geometry. The canvas knows a glTF node key;
 * everything below is a PLM part with a number, a state and a detail page.
 */

/**
 * The caption, bottom center of the viewport.
 *
 * Bottom center rather than beside the file name at bottom left, which is
 * already occupied — and the only other thing that renders here is the
 * comparison's loading pill, which cannot coincide with a selection because
 * comparing turns picking off.
 */
export function CADSelectionCaption({
  selection,
}: {
  selection: CADSelectionState
}) {
  const node = selection.selectedNode
  if (!node) return null

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 max-w-[min(32rem,calc(100%-2rem))] bg-white/90 dark:bg-slate-900/90 backdrop-blur-sm px-3 py-2 rounded-lg shadow-lg">
      {node.part ? (
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-semibold text-slate-900 dark:text-white shrink-0">
            {node.part.itemNumber}
          </span>
          <span className="text-xs text-slate-600 dark:text-slate-400 truncate">
            {node.part.name ?? node.name}
          </span>
          <span className="text-[11px] text-slate-400 dark:text-slate-500 shrink-0">
            Rev {node.part.revision}
          </span>
          <StateBadge itemType={node.part.itemType} state={node.part.state} />
        </div>
      ) : (
        <div className="flex items-center gap-2 min-w-0">
          <HelpCircle className="h-3.5 w-3.5 text-amber-500 shrink-0" />
          <span className="text-xs font-medium text-slate-700 dark:text-slate-300 truncate">
            {node.name}
          </span>
          <span className="text-[11px] text-slate-500 dark:text-slate-400 shrink-0">
            {node.resolution === 'excluded'
              ? 'not a BOM part'
              : 'no matching part'}
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * The right-click menu for the selected part.
 *
 * Acts on the *selection* rather than on a separate right-click target,
 * because right-clicking a part selects it — which is both what CAD tools do
 * and what removes the one race worth avoiding here: the menu renders in a
 * commit after the click that set the selection, so there is no window in
 * which it can point at the part selected before it.
 */
export function CADSelectionMenu({
  selection,
  onRelink,
}: {
  selection: CADSelectionState
  /** Open the dialog that says what this node actually is. */
  onRelink: () => void
}) {
  const navigate = useNavigate()
  const node = selection.selectedNode

  if (!node) {
    return (
      <ContextMenuContent>
        <ContextMenuItem disabled>
          <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
          Click a part to select it
        </ContextMenuItem>
      </ContextMenuContent>
    )
  }

  const route = node.part
    ? getItemDetailPath(node.part.itemType, node.part.itemId)
    : null

  return (
    <ContextMenuContent className="max-w-xs">
      <ContextMenuLabel className="truncate">
        {node.part?.itemNumber ?? node.name}
      </ContextMenuLabel>
      <ContextMenuSeparator />

      {route ? (
        <>
          <ContextMenuItem
            onClick={() =>
              // noopener/noreferrer: the new tab must not get a handle back to
              // this window through `opener`.
              window.open(route, '_blank', 'noopener,noreferrer')
            }
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            Open in new tab
          </ContextMenuItem>
          <ContextMenuItem onClick={() => navigate({ to: route })}>
            <MousePointerClick className="mr-1.5 h-3.5 w-3.5" />
            Open
          </ContextMenuItem>
        </>
      ) : (
        <ContextMenuItem disabled>
          <HelpCircle className="mr-1.5 h-3.5 w-3.5" />
          {node.resolution === 'excluded'
            ? 'Marked as not a BOM part'
            : 'No matching part in this BOM'}
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />
      <ContextMenuItem onClick={onRelink}>
        <Link2 className="mr-1.5 h-3.5 w-3.5" />
        {node.part ? 'Link to a different part…' : 'Link to a part…'}
      </ContextMenuItem>
      <ContextMenuItem onClick={() => void copyLabel(node)}>
        <Copy className="mr-1.5 h-3.5 w-3.5" />
        Copy {node.part ? 'part number' : 'CAD name'}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/**
 * Put the part's identity on the clipboard — its number where it has one, the
 * CAD's own name where it does not, which is the string someone chasing an
 * unmatched node actually needs to search for.
 *
 * Failure is swallowed: `writeText` rejects on a page without clipboard
 * permission, and a menu item that throws into the console is worse than one
 * that quietly does nothing.
 */
async function copyLabel(node: CadModelNode): Promise<void> {
  try {
    await navigator.clipboard.writeText(node.part?.itemNumber ?? node.name)
  } catch {
    // No clipboard access — nothing useful to say about it here.
  }
}
