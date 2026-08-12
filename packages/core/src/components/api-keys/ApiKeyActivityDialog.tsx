// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useQuery } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import type { ApiKeyEvent, ApiKeyRecord } from '@/lib/query'
import { Badge } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { adminApiKeyActivityQuery, myApiKeyActivityQuery } from '@/lib/query'

interface ApiKeyActivityDialogProps {
  apiKey: Pick<ApiKeyRecord, 'id' | 'name' | 'keyPrefix'> | null
  /** Admin reads any key's activity; self-service only the caller's own. */
  scope: 'admin' | 'self'
  onClose: () => void
}

const OUTCOME_LABELS: Record<string, string> = {
  success: 'Authenticated',
  expired: 'Rejected — expired',
  disabled: 'Rejected — disabled',
  revoked: 'Rejected — revoked',
  inactive_user: 'Rejected — owner inactive',
}

function outcomeVariant(outcome: string) {
  return outcome === 'success' ? 'secondary' : 'destructive'
}

function formatTimestamp(value: string): string {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function ApiKeyActivityDialog({
  apiKey,
  scope,
  onClose,
}: ApiKeyActivityDialogProps) {
  return (
    <Dialog
      open={apiKey !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Activity</DialogTitle>
          <DialogDescription>
            {apiKey
              ? `${apiKey.name} (${apiKey.keyPrefix}…) — most recent first.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        {apiKey && <ActivityBody keyId={apiKey.id} scope={scope} />}
      </DialogContent>
    </Dialog>
  )
}

/**
 * Split out so the query only mounts (and fetches) once a key is selected —
 * hooks cannot be called conditionally in the parent.
 */
function ActivityBody({
  keyId,
  scope,
}: {
  keyId: string
  scope: 'admin' | 'self'
}) {
  const {
    data: events = [],
    isPending,
    error,
  } = useQuery(
    scope === 'admin'
      ? adminApiKeyActivityQuery(keyId)
      : myApiKeyActivityQuery(keyId),
  )

  if (isPending) {
    return <p className="text-sm text-muted-foreground">Loading activity…</p>
  }

  if (error) {
    return (
      <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded text-sm">
        {error.message}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          Successful requests are sampled at most once a minute, so this is a
          usage timeline rather than a complete request log. Every rejection is
          recorded.
        </span>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No activity recorded for this key yet.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700 text-left">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Outcome</th>
                <th className="py-2 pr-4 font-medium">Request</th>
                <th className="py-2 pr-4 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event: ApiKeyEvent) => (
                <tr
                  key={event.id}
                  className="border-b border-slate-100 dark:border-slate-800"
                >
                  <td className="py-2 pr-4 whitespace-nowrap">
                    {formatTimestamp(event.occurredAt)}
                  </td>
                  <td className="py-2 pr-4">
                    <Badge
                      variant={outcomeVariant(event.outcome)}
                      className="text-xs"
                    >
                      {OUTCOME_LABELS[event.outcome] ?? event.outcome}
                    </Badge>
                  </td>
                  <td className="py-2 pr-4">
                    {event.method || event.path ? (
                      <code className="text-xs">
                        {event.method} {event.path}
                      </code>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    <div className="text-xs">{event.ipAddress ?? '—'}</div>
                    {event.userAgent && (
                      <div
                        className="text-xs text-muted-foreground truncate max-w-[16rem]"
                        title={event.userAgent}
                      >
                        {event.userAgent}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
