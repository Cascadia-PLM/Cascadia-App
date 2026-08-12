// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  Activity,
  Ban,
  MoreHorizontal,
  Pencil,
  Play,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import type { AdminApiKeyRecord, ApiKeyRecord } from '@/lib/query'
import type { ApiKeyStatus } from '@/lib/auth/ApiKeyService'
import { Badge, Button } from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'

const STATUS_VARIANT: Record<
  ApiKeyStatus,
  'success' | 'warning' | 'secondary' | 'outline'
> = {
  active: 'success',
  disabled: 'warning',
  expired: 'secondary',
  revoked: 'outline',
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/** Days remaining, or null when the key does not expire / already lapsed. */
function daysUntil(value: string | null): number | null {
  if (!value) return null
  const ms = new Date(value).getTime() - Date.now()
  if (ms <= 0) return null
  return Math.ceil(ms / (24 * 60 * 60 * 1000))
}

export interface ApiKeyTableProps {
  keys: Array<ApiKeyRecord | AdminApiKeyRecord>
  /** Admin tables show an Owner column; self-service does not. */
  showOwner?: boolean
  onEdit: (key: ApiKeyRecord) => void
  onRotate: (key: ApiKeyRecord) => void
  onToggleDisabled: (key: ApiKeyRecord) => void
  onRevoke: (key: ApiKeyRecord) => void
  onViewActivity: (key: ApiKeyRecord) => void
  busyKeyId?: string | null
}

function hasOwner(
  key: ApiKeyRecord | AdminApiKeyRecord,
): key is AdminApiKeyRecord {
  return 'userEmail' in key
}

export function ApiKeyTable({
  keys,
  showOwner = false,
  onEdit,
  onRotate,
  onToggleDisabled,
  onRevoke,
  onViewActivity,
  busyKeyId,
}: ApiKeyTableProps) {
  if (keys.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No API keys yet. Create one to let a headless client authenticate.
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-700 text-left">
            <th className="py-2 pr-4 font-medium">Name</th>
            {showOwner && <th className="py-2 pr-4 font-medium">Owner</th>}
            <th className="py-2 pr-4 font-medium">Permissions</th>
            <th className="py-2 pr-4 font-medium">Roles</th>
            <th className="py-2 pr-4 font-medium">Expires</th>
            <th className="py-2 pr-4 font-medium">Last used</th>
            <th className="py-2 pr-4 font-medium">Status</th>
            <th className="py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => {
            const remaining = daysUntil(key.expiresAt)
            const isRevoked = key.status === 'revoked'
            const permissionCount = key.permissions
              ? Object.keys(key.permissions).length
              : null

            return (
              <tr
                key={key.id}
                className="border-b border-slate-100 dark:border-slate-800"
              >
                <td className="py-2 pr-4">
                  <div className="font-medium">{key.name}</div>
                  <code className="text-xs text-muted-foreground">
                    {key.keyPrefix}…
                  </code>
                  {key.rotatedAt && (
                    <div className="text-xs text-muted-foreground">
                      Rotated {formatDate(key.rotatedAt)}
                    </div>
                  )}
                </td>

                {showOwner && (
                  <td className="py-2 pr-4">
                    {hasOwner(key) ? (
                      <>
                        <div>{key.userName ?? '—'}</div>
                        <div className="text-xs text-muted-foreground">
                          {key.userEmail}
                        </div>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                )}

                <td className="py-2 pr-4">
                  {permissionCount === null ? (
                    <Badge variant="outline" className="text-xs">
                      All owner permissions
                    </Badge>
                  ) : (
                    <span className="text-xs">
                      {permissionCount} resource
                      {permissionCount === 1 ? '' : 's'}
                    </span>
                  )}
                </td>

                <td className="py-2 pr-4">
                  {key.roles === null ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
                      title="This key inherits every role its owner holds, including role-gated actions like import branch-protection bypass."
                    >
                      <ShieldAlert className="w-3 h-3" />
                      All owner roles
                    </span>
                  ) : key.roles.length === 0 ? (
                    <Badge variant="secondary" className="text-xs">
                      None
                    </Badge>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {key.roles.map((role) => (
                        <Badge
                          key={role}
                          variant="secondary"
                          className="text-xs"
                        >
                          {role}
                        </Badge>
                      ))}
                    </div>
                  )}
                </td>

                <td className="py-2 pr-4">
                  <div>{formatDate(key.expiresAt)}</div>
                  {remaining !== null && remaining <= 14 && (
                    <div className="text-xs text-amber-600 dark:text-amber-400">
                      {remaining}d left
                    </div>
                  )}
                </td>

                <td className="py-2 pr-4">{formatDate(key.lastUsedAt)}</td>

                <td className="py-2 pr-4">
                  <Badge
                    variant={STATUS_VARIANT[key.status]}
                    className="text-xs capitalize"
                  >
                    {key.status}
                  </Badge>
                </td>

                <td className="py-2 text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busyKeyId === key.id}
                        aria-label={`Actions for ${key.name}`}
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => onViewActivity(key)}>
                        <Activity className="w-4 h-4 mr-2" />
                        View activity
                      </DropdownMenuItem>

                      {/* A revoked key is a historical record: readable, not
                          editable. Everything below would be a no-op on it. */}
                      {!isRevoked && (
                        <>
                          <DropdownMenuItem onClick={() => onEdit(key)}>
                            <Pencil className="w-4 h-4 mr-2" />
                            Edit name &amp; scope
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => onToggleDisabled(key)}
                          >
                            {key.status === 'disabled' ? (
                              <>
                                <Play className="w-4 h-4 mr-2" />
                                Enable
                              </>
                            ) : (
                              <>
                                <Ban className="w-4 h-4 mr-2" />
                                Disable
                              </>
                            )}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onRotate(key)}>
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Rotate secret
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onRevoke(key)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Ban className="w-4 h-4 mr-2" />
                            Revoke permanently
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
