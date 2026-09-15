// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo, useState } from 'react'
import { Ban, RotateCcw, Search } from 'lucide-react'
import type { CADSelectionState } from './useCADSelectionState'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@/components/ui'
import { StateBadge } from '@/components/items/StateBadge'

/**
 * Say what a part of the model actually is, when the automatic match got it
 * wrong or found nothing.
 *
 * The choices are the assembly's own BOM children and nothing else. That is a
 * deliberate limit rather than a missing feature: a node in this assembly's
 * model is a part this assembly places, so offering the whole instance would
 * mostly offer ways to record something untrue. A node that really is not a
 * BOM part — a fixture, a weld bead, packaging the CAD carries — gets the
 * explicit escape hatch below instead.
 */
export function CADNodeLinkDialog({
  selection,
  open,
  onOpenChange,
}: {
  selection: CADSelectionState
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [search, setSearch] = useState('')
  const node = selection.selectedNode

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()
    if (!needle) return selection.candidates
    return selection.candidates.filter(
      (candidate) =>
        candidate.itemNumber.toLowerCase().includes(needle) ||
        (candidate.name ?? '').toLowerCase().includes(needle),
    )
  }, [selection.candidates, search])

  if (!node) return null

  const close = () => {
    setSearch('')
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Link model part</DialogTitle>
          <DialogDescription>
            <span className="font-mono text-xs">{node.name}</span> in this
            assembly&apos;s model. Choose the part it represents.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <Input
            autoFocus
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by part number or name"
            className="pl-8"
          />
        </div>

        <div className="max-h-72 overflow-y-auto -mx-1 px-1">
          {matches.length === 0 ? (
            <p className="py-8 text-center text-sm text-slate-500 dark:text-slate-400">
              {selection.candidates.length === 0
                ? 'This assembly has no BOM children to link to.'
                : 'No BOM child matches that filter.'}
            </p>
          ) : (
            <ul className="space-y-1">
              {matches.map((candidate) => {
                const isCurrent = node.part?.masterId === candidate.masterId
                return (
                  <li key={candidate.masterId}>
                    <button
                      type="button"
                      disabled={selection.isLinking}
                      onClick={() => {
                        selection.linkSelected(candidate.itemId)
                        close()
                      }}
                      className={`w-full text-left px-3 py-2 rounded-md flex items-center gap-2 transition-colors disabled:opacity-50 ${
                        isCurrent
                          ? 'bg-blue-50 dark:bg-blue-950/40'
                          : 'hover:bg-slate-100 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span className="text-xs font-semibold text-slate-900 dark:text-white shrink-0">
                        {candidate.itemNumber}
                      </span>
                      <span className="text-xs text-slate-600 dark:text-slate-400 truncate">
                        {candidate.name}
                      </span>
                      <span className="ml-auto flex items-center gap-1.5 shrink-0">
                        {isCurrent && (
                          <Badge variant="outline" className="text-[10px]">
                            current
                          </Badge>
                        )}
                        <StateBadge
                          itemType={candidate.itemType}
                          state={candidate.state}
                        />
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="sm:justify-between gap-2">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={selection.isLinking}
              onClick={() => {
                selection.linkSelected(null)
                close()
              }}
              title="Record that this is not a BOM part, and stop matching it"
            >
              <Ban className="h-4 w-4 mr-2" />
              Not a BOM part
            </Button>
            {node.resolution !== 'auto' && node.resolution !== 'unmatched' && (
              <Button
                variant="ghost"
                size="sm"
                disabled={selection.isLinking}
                onClick={() => {
                  selection.unlinkSelected()
                  close()
                }}
                title="Forget this decision and match by name again"
              >
                <RotateCcw className="h-4 w-4 mr-2" />
                Reset to automatic
              </Button>
            )}
          </div>
          <Button variant="ghost" size="sm" onClick={close}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
