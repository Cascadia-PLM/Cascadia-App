// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { AlertCircle, Plus } from 'lucide-react'
import { ApiKeyTable } from './ApiKeyTable'
import { ApiKeyFormDialog } from './ApiKeyFormDialog'
import { ApiKeySecretDialog } from './ApiKeySecretDialog'
import { ApiKeyActivityDialog } from './ApiKeyActivityDialog'
import type { AdminApiKeyRecord, ApiKeyRecord } from '@/lib/query'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { Button } from '@/components/ui'
import { useInvalidateResources } from '@/lib/query'
import { ApiError, apiFetch } from '@/lib/api/client'

interface ApiKeyManagerProps {
  keys: Array<ApiKeyRecord | AdminApiKeyRecord>
  scopableRoles: Array<string>
  /** '/api/v1/auth/api-keys' or '/api/v1/admin/api-keys'. */
  basePath: string
  scope: 'admin' | 'self'
  showOwner?: boolean
  /** Admin pages create keys for themselves via the self-service path. */
  createPath?: string
}

/**
 * Every key mutation and its dialogs, in one place.
 *
 * The admin page and the self-service page differ only in which endpoints
 * they call and whether an Owner column appears; the interaction model —
 * edit, rotate, disable, revoke, inspect activity — is identical, so it lives
 * here rather than being written twice and drifting.
 */
export function ApiKeyManager({
  keys,
  scopableRoles,
  basePath,
  scope,
  showOwner = false,
  createPath,
}: ApiKeyManagerProps) {
  const invalidate = useInvalidateResources()

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<ApiKeyRecord | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [secretMode, setSecretMode] = useState<'created' | 'rotated'>('created')
  const [activityKey, setActivityKey] = useState<ApiKeyRecord | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null)
  const [rotateTarget, setRotateTarget] = useState<ApiKeyRecord | null>(null)
  const [busyKeyId, setBusyKeyId] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState('')

  const refresh = async () => {
    await invalidate('auth')
    await invalidate('admin')
  }

  /** Every mutation shares this shape: mark busy, call, refresh, surface. */
  const run = async (keyId: string, fn: () => Promise<void>) => {
    setBusyKeyId(keyId)
    setErrorMessage('')
    try {
      await fn()
      await refresh()
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : 'The operation failed',
      )
    } finally {
      setBusyKeyId(null)
    }
  }

  const handleToggleDisabled = (key: ApiKeyRecord) => {
    const action = key.status === 'disabled' ? 'enable' : 'disable'
    void run(key.id, async () => {
      await apiFetch(`${basePath}/${key.id}/${action}`, { method: 'POST' })
    })
  }

  const handleRotate = () => {
    const key = rotateTarget
    if (!key) return
    setRotateTarget(null)
    void run(key.id, async () => {
      const result = await apiFetch<{ data: { key: string } }>(
        `${basePath}/${key.id}/rotate`,
        { method: 'POST' },
      )
      setSecretMode('rotated')
      setSecret(result.data.key)
    })
  }

  const handleRevoke = () => {
    const key = revokeTarget
    if (!key) return
    setRevokeTarget(null)
    void run(key.id, async () => {
      await apiFetch(`${basePath}/${key.id}`, { method: 'DELETE' })
    })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div />
        <Button
          onClick={() => {
            setEditing(null)
            setFormOpen(true)
          }}
        >
          <Plus className="w-4 h-4 mr-2" />
          New key
        </Button>
      </div>

      {errorMessage && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertCircle className="w-4 h-4" />
          {errorMessage}
        </div>
      )}

      <ApiKeyTable
        keys={keys}
        showOwner={showOwner}
        busyKeyId={busyKeyId}
        onEdit={(key) => {
          setEditing(key)
          setFormOpen(true)
        }}
        onRotate={setRotateTarget}
        onToggleDisabled={handleToggleDisabled}
        onRevoke={setRevokeTarget}
        onViewActivity={setActivityKey}
      />

      <ApiKeyFormDialog
        open={formOpen}
        editing={editing}
        scopableRoles={scopableRoles}
        // Creation always goes through the self-service path: a key is minted
        // for whoever is signed in, never on another user's behalf.
        basePath={editing ? basePath : (createPath ?? basePath)}
        onClose={() => setFormOpen(false)}
        onCreated={(created) => {
          setSecretMode('created')
          setSecret(created)
        }}
        onSaved={() => void refresh()}
      />

      <ApiKeySecretDialog
        secret={secret}
        mode={secretMode}
        onClose={() => setSecret(null)}
      />

      <ApiKeyActivityDialog
        apiKey={activityKey}
        scope={scope}
        onClose={() => setActivityKey(null)}
      />

      {/* Rotate confirmation — destructive to running clients, not to data. */}
      <Dialog
        open={rotateTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRotateTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate secret</DialogTitle>
            <DialogDescription>
              {rotateTarget
                ? `"${rotateTarget.name}" keeps its scope and activity history, but its current secret stops working immediately. Every client using it will fail until updated.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateTarget(null)}>
              Cancel
            </Button>
            <Button onClick={handleRotate}>Rotate secret</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirmation — permanent. */}
      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key</DialogTitle>
            <DialogDescription>
              {revokeTarget
                ? `"${revokeTarget.name}" (${revokeTarget.keyPrefix}…) stops working immediately and cannot be re-enabled. To pause a key temporarily, disable it instead.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevoke}>
              Revoke permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
