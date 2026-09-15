// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ClipboardList,
  ListPlus,
  Play,
  RefreshCw,
  SkipForward,
  Trash2,
  Undo2,
} from 'lucide-react'
import type {
  WorkOrderInstruction,
  WorkOrderInstructionStatus,
} from '@/lib/items/types/work-order'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
} from '@/components/ui'
import { ExecutionHistoryTable } from '@/components/work-instructions/ExecutionHistoryTable'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'
import {
  itemTextSearchQuery,
  useInvalidateResources,
  workOrderExecutionsQuery,
  workOrderInstructionsQuery,
} from '@/lib/query'
import { cn } from '@/lib/utils'

interface WorkOrderTravelerSectionProps {
  workOrderId: string
  /** Complete/Cancelled orders can no longer change the traveler */
  readOnly?: boolean
}

interface TemplateSuggestion {
  id: string
  itemNumber: string
  name?: string | null
}

const statusStyles: Record<WorkOrderInstructionStatus, string> = {
  'Not Started':
    'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
  'In Progress':
    'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300',
  Complete:
    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
  Skipped: 'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
}

/**
 * The traveler: instances of work instruction templates carried by this
 * order, in build sequence. Lines are frozen snapshots — the shop floor
 * executes these, never the template masters.
 */
export function WorkOrderTravelerSection({
  workOrderId,
  readOnly = false,
}: WorkOrderTravelerSectionProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [addOpen, setAddOpen] = useState(false)
  const [skipTarget, setSkipTarget] = useState<WorkOrderInstruction | null>(
    null,
  )
  const [skipReason, setSkipReason] = useState('')
  const [busy, setBusy] = useState(false)

  const { data: instructions } = useQuery(
    workOrderInstructionsQuery(workOrderId),
  )
  const { data: executions } = useQuery(workOrderExecutionsQuery(workOrderId))

  const lines = instructions ?? []

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await invalidate('work-orders')
    } catch (error) {
      handleError(error)
    } finally {
      setBusy(false)
    }
  }

  const handlePopulate = () =>
    act(async () => {
      const result = await apiFetch<{
        data: { created: Array<WorkOrderInstruction>; skipped: number }
      }>(`/api/v1/work-orders/${workOrderId}/instructions/populate`, {
        method: 'POST',
      })
      const created = result.data.created.length
      showSuccess(
        created > 0
          ? `${created} instruction${created === 1 ? '' : 's'} added`
          : 'Traveler already up to date',
        created > 0
          ? 'Instantiated from part attachments across the BOM'
          : 'Every applicable template is already on the traveler',
      )
    })

  const handleMove = (line: WorkOrderInstruction, direction: -1 | 1) => {
    const index = lines.findIndex((l) => l.id === line.id)
    const other = lines[index + direction]
    if (!other) return
    return act(() =>
      apiFetch(`/api/v1/work-orders/${workOrderId}/instructions`, {
        method: 'PUT',
        body: JSON.stringify({
          instructions: [
            { id: line.id, orderIndex: other.orderIndex },
            { id: other.id, orderIndex: line.orderIndex },
          ],
        }),
      }),
    )
  }

  const handleSkip = () => {
    if (!skipTarget || !skipReason.trim()) return
    const target = skipTarget
    return act(async () => {
      await apiFetch(
        `/api/v1/work-orders/${workOrderId}/instructions/${target.id}/skip`,
        {
          method: 'POST',
          body: JSON.stringify({ reason: skipReason.trim() }),
        },
      )
      setSkipTarget(null)
      setSkipReason('')
    })
  }

  const handleUnskip = (line: WorkOrderInstruction) =>
    act(() =>
      apiFetch(
        `/api/v1/work-orders/${workOrderId}/instructions/${line.id}/unskip`,
        { method: 'POST' },
      ),
    )

  const handleRefresh = (line: WorkOrderInstruction) =>
    act(async () => {
      await apiFetch(
        `/api/v1/work-orders/${workOrderId}/instructions/${line.id}/refresh`,
        { method: 'POST' },
      )
      showSuccess(
        'Snapshot refreshed',
        `"${line.title}" re-frozen from its template`,
      )
    })

  const handleRemove = (line: WorkOrderInstruction) =>
    act(() =>
      apiFetch(`/api/v1/work-orders/${workOrderId}/instructions/${line.id}`, {
        method: 'DELETE',
      }),
    )

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle>Traveler</CardTitle>
              <CardDescription>
                The instructions this order executes — frozen copies of the
                templates, in build sequence
              </CardDescription>
            </div>
            {!readOnly && (
              <div className="flex gap-2 shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handlePopulate}
                  disabled={busy}
                >
                  <ClipboardList className="h-4 w-4 mr-2" />
                  Populate from part
                </Button>
                <Button size="sm" onClick={() => setAddOpen(true)}>
                  <ListPlus className="h-4 w-4 mr-2" />
                  Add instruction
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <p className="text-slate-500 text-center py-8">
              No instructions yet. Add templates by hand, or populate from the
              work instructions attached to this order's part and its BOM.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Instruction</TableHead>
                  <TableHead>Part</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, index) => (
                  <TableRow
                    key={line.id}
                    className={cn(line.status === 'Skipped' && 'opacity-60')}
                  >
                    <TableCell className="text-slate-400 tabular-nums">
                      {index + 1}
                    </TableCell>
                    <TableCell>
                      <div>
                        <span
                          className={cn(
                            'font-medium',
                            line.status === 'Skipped' && 'line-through',
                          )}
                        >
                          {line.title}
                        </span>
                        <div className="text-xs text-slate-500">
                          {line.instructionNumber}
                          {line.workInstructionId === null &&
                            ' · template deleted'}
                          {line.skipReason && ` · skipped: ${line.skipReason}`}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {line.part ? (
                        <Link
                          to="/parts/$id"
                          params={{ id: line.part.id }}
                          className="text-sky-600 dark:text-sky-400 hover:text-sky-700 dark:hover:text-sky-300 text-sm"
                        >
                          {line.part.itemNumber}
                        </Link>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="tabular-nums text-sm">
                        {line.completedCount} / {line.requiredCount}
                      </span>
                      {line.executionCount > line.completedCount && (
                        <span className="text-xs text-slate-500 ml-1.5">
                          ({line.executionCount - line.completedCount} open)
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="secondary"
                        className={cn('font-medium', statusStyles[line.status])}
                      >
                        {line.status}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        {!readOnly && line.status !== 'Skipped' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-emerald-600 dark:text-emerald-400 hover:text-emerald-700 dark:hover:text-emerald-300"
                            asChild
                          >
                            <Link
                              to="/work-orders/$id/run/$instructionId"
                              params={{
                                id: workOrderId,
                                instructionId: line.id,
                              }}
                            >
                              <Play className="h-4 w-4 mr-1" />
                              Run
                            </Link>
                          </Button>
                        )}
                        {!readOnly && (
                          <>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              disabled={busy || index === 0}
                              onClick={() => handleMove(line, -1)}
                              title="Move up"
                            >
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              disabled={busy || index === lines.length - 1}
                              onClick={() => handleMove(line, 1)}
                              title="Move down"
                            >
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                            {line.status === 'Skipped' ? (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                disabled={busy}
                                onClick={() => handleUnskip(line)}
                                title="Unskip"
                              >
                                <Undo2 className="h-4 w-4" />
                              </Button>
                            ) : (
                              line.status !== 'Complete' && (
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8"
                                  disabled={busy}
                                  onClick={() => {
                                    setSkipTarget(line)
                                    setSkipReason('')
                                  }}
                                  title="Skip (requires reason)"
                                >
                                  <SkipForward className="h-4 w-4" />
                                </Button>
                              )
                            )}
                            {line.executionCount === 0 && (
                              <>
                                {line.workInstructionId && (
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-8 w-8"
                                    disabled={busy}
                                    onClick={() => handleRefresh(line)}
                                    title="Re-freeze from template"
                                  >
                                    <RefreshCw className="h-4 w-4" />
                                  </Button>
                                )}
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  className="h-8 w-8 text-red-500 hover:text-red-600 dark:hover:text-red-400"
                                  disabled={busy}
                                  onClick={() => handleRemove(line)}
                                  title="Remove"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Execution History</CardTitle>
          <CardDescription>
            Every run recorded against this order's traveler
          </CardDescription>
        </CardHeader>
        <CardContent>
          {(executions ?? []).length > 0 ? (
            <ExecutionHistoryTable
              executions={executions ?? []}
              workOrderId={workOrderId}
            />
          ) : (
            <p className="text-slate-500 text-center py-8">
              No executions yet. Run a traveler instruction to see records here.
            </p>
          )}
        </CardContent>
      </Card>

      <AddInstructionDialog
        workOrderId={workOrderId}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => invalidate('work-orders')}
      />

      <Dialog
        open={skipTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSkipTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Skip "{skipTarget?.title}"?</DialogTitle>
            <DialogDescription>
              Skipping marks this instruction not applicable for this order. The
              reason is recorded and the line stops blocking completion.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={skipReason}
            onChange={(e) => setSkipReason(e.target.value)}
            placeholder="Why is this instruction not applicable?"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSkipTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleSkip} disabled={busy || !skipReason.trim()}>
              <SkipForward className="h-4 w-4 mr-2" />
              Skip instruction
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AddInstructionDialog({
  workOrderId,
  open,
  onOpenChange,
  onAdded,
}: {
  workOrderId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => Promise<unknown>
}) {
  const { handleError, showSuccess } = useErrorHandler()
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<TemplateSuggestion | null>(null)
  const [perUnit, setPerUnit] = useState(false)
  const [requiredCount, setRequiredCount] = useState('1')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) {
      setQuery('')
      setSelected(null)
      setPerUnit(false)
      setRequiredCount('1')
    }
  }, [open])

  const debouncedQuery = useDebouncedValue(query.trim(), 250)
  const { data: suggestions = [] } = useQuery(
    itemTextSearchQuery<TemplateSuggestion>(
      { q: debouncedQuery, types: ['WorkInstruction'], limit: 8 },
      !selected && debouncedQuery.length >= 2,
    ),
  )

  const handleAdd = async () => {
    if (!selected) return
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        workInstructionId: selected.id,
      }
      if (perUnit) {
        body.perUnit = true
      } else {
        const parsed = parseInt(requiredCount, 10)
        if (parsed > 1) body.requiredCount = parsed
      }
      await apiFetch(`/api/v1/work-orders/${workOrderId}/instructions`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
      showSuccess('Instruction added', `${selected.itemNumber} instantiated`)
      await onAdded()
      onOpenChange(false)
    } catch (error) {
      handleError(error)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add instruction to traveler</DialogTitle>
          <DialogDescription>
            The template's current content is frozen into this order — later
            template edits won't change it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {selected ? (
            <div className="flex items-center justify-between p-3 border rounded-lg bg-slate-50 dark:bg-slate-800">
              <div>
                <span className="font-medium">{selected.itemNumber}</span>
                {selected.name && (
                  <span className="text-slate-500 ml-2">{selected.name}</span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelected(null)}
              >
                Change
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search work instruction templates…"
                autoFocus
              />
              {suggestions.length > 0 && (
                <div className="border rounded-lg divide-y dark:divide-slate-700 max-h-56 overflow-auto">
                  {suggestions.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="w-full text-left px-3 py-2 hover:bg-slate-50 dark:hover:bg-slate-800"
                      onClick={() => setSelected(s)}
                    >
                      <span className="font-medium">{s.itemNumber}</span>
                      {s.name && (
                        <span className="text-slate-500 ml-2">{s.name}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={perUnit}
                onChange={(e) => setPerUnit(e.target.checked)}
                className="h-4 w-4 rounded border-slate-300 dark:border-slate-700"
              />
              Once per unit (required runs = order quantity)
            </label>
            {!perUnit && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-slate-600 dark:text-slate-400">
                  Required runs:
                </span>
                <Input
                  type="number"
                  min={1}
                  value={requiredCount}
                  onChange={(e) => setRequiredCount(e.target.value)}
                  className="w-24"
                />
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!selected || saving}>
            <ListPlus className="h-4 w-4 mr-2" />
            {saving ? 'Adding…' : 'Add to traveler'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
