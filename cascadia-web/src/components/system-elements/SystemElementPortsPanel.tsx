// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
/**
 * The ports of a system element, on the element's own page: its named
 * connection points, which the design's interfaces attach to. The same
 * list the block diagram draws down the block's edges, and edited through
 * the same endpoints.
 *
 * A port is a field of the element's row, so the panel edits the row the
 * page is showing — the working copy when the page is on a branch — and is
 * editable exactly when the element is.
 */
import { useState } from 'react'
import { Pencil, Plus } from 'lucide-react'
import { SYSTEM_PORT_DIRECTION_LABELS } from '@cascadia/commons/items/types/system-element'
import type { SystemPort } from '@cascadia/commons/items/types/system-element'
import { apiFetch } from '@/api/client'
import { PortDialog } from '@/components/designs/block-diagram/BlockDiagramDialogs'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import { useResourceMutation } from '@/query'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface SystemElementPortsPanelProps {
  elementId: string
  /** "SE-000001 Power", for the dialogs. */
  elementLabel: string
  ports: Array<SystemPort>
  isEditable?: boolean
}

export function SystemElementPortsPanel({
  elementId,
  elementLabel,
  ports,
  isEditable = false,
}: SystemElementPortsPanelProps) {
  const { handleError } = useErrorHandler()
  // null: closed; 'new': adding; otherwise the port being edited.
  const [editing, setEditing] = useState<SystemPort | 'new' | null>(null)
  const write = useResourceMutation({
    mutationFn: (request: { title: string; run: () => Promise<unknown> }) =>
      request.run(),
    invalidates: ['system-elements'],
    onSuccess: () => setEditing(null),
    onError: (error, request) => handleError(error, { title: request.title }),
  })
  const base = `/api/v1/system-elements/${elementId}/ports`
  const sorted = [...ports].sort((a, b) => a.name.localeCompare(b.name))

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Ports</CardTitle>
            <CardDescription>
              The connection points interfaces attach to
            </CardDescription>
          </div>
          {isEditable && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing('new')}
            >
              <Plus className="h-4 w-4 mr-2" />
              Add port
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            This element has no ports yet
          </p>
        ) : (
          <ul className="divide-y">
            {sorted.map((port) => (
              <li
                key={port.id}
                className="flex items-center justify-between py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm">{port.name}</span>
                  <Badge variant="outline" className="text-xs">
                    {SYSTEM_PORT_DIRECTION_LABELS[port.direction]}
                  </Badge>
                  {port.description && (
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                      {port.description}
                    </span>
                  )}
                </div>
                {isEditable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setEditing(port)}
                    title="Edit port"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      {editing === 'new' && (
        <PortDialog
          title="Add port"
          elementLabel={elementLabel}
          submitLabel="Add port"
          busy={write.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            write.mutate({
              title: 'Could not add the port',
              run: () =>
                apiFetch(base, {
                  method: 'POST',
                  body: JSON.stringify(values),
                }),
            })
          }
        />
      )}
      {editing && editing !== 'new' && (
        <PortDialog
          title={`Port ${editing.name}`}
          elementLabel={elementLabel}
          existing={editing}
          submitLabel="Save"
          busy={write.isPending}
          onClose={() => setEditing(null)}
          onSubmit={(values) =>
            write.mutate({
              title: 'Could not update the port',
              run: () =>
                apiFetch(`${base}/${editing.id}`, {
                  method: 'PUT',
                  body: JSON.stringify(values),
                }),
            })
          }
          onDelete={() =>
            write.mutate({
              title: 'Could not delete the port',
              run: () =>
                apiFetch(`${base}/${editing.id}`, { method: 'DELETE' }),
            })
          }
        />
      )}
    </Card>
  )
}
