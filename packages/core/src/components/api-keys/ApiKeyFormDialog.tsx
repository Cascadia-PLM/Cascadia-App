// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle } from 'lucide-react'
import {
  ApiKeyScopeEditor,
  UNRESTRICTED_SCOPE,
  scopeStateFromKey,
  scopeStateToPayload,
} from './ApiKeyScopeEditor'
import type { ApiKeyRecord } from '@/lib/query'
import type { ScopeState } from './ApiKeyScopeEditor'
import { Button, Input, Label } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { apiKeyPolicyQuery } from '@/lib/query'
import { ApiError, apiFetch } from '@/lib/api/client'

interface ApiKeyFormDialogProps {
  open: boolean
  /** Null creates a key; a record edits that key in place. */
  editing: ApiKeyRecord | null
  /** Roles the key's owner may grant. */
  scopableRoles: Array<string>
  /** Base path — '/api/v1/auth/api-keys' or '/api/v1/admin/api-keys'. */
  basePath: string
  onClose: () => void
  onCreated: (secret: string) => void
  onSaved: () => void
}

/**
 * Create and edit share one dialog because they configure the same thing.
 * The differences are narrow: create can set an expiry and returns a secret;
 * edit cannot change either, since an expiry change would silently extend a
 * credential past what the policy allowed at issuance.
 */
export function ApiKeyFormDialog({
  open,
  editing,
  scopableRoles,
  basePath,
  onClose,
  onCreated,
  onSaved,
}: ApiKeyFormDialogProps) {
  const { data: policyData } = useQuery(apiKeyPolicyQuery())
  const policy = policyData?.policy

  const [name, setName] = useState('')
  const [expiresInDays, setExpiresInDays] = useState('')
  const [scope, setScope] = useState<ScopeState>(UNRESTRICTED_SCOPE)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')

  // Reload the form whenever it opens, so a previous edit never bleeds into
  // the next one.
  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setExpiresInDays('')
    setScope(editing ? scopeStateFromKey(editing) : UNRESTRICTED_SCOPE)
    setErrorMessage('')
  }, [open, editing])

  const handleSubmit = async () => {
    setSaving(true)
    setErrorMessage('')
    try {
      const scopePayload = scopeStateToPayload(scope)

      if (editing) {
        await apiFetch(`${basePath}/${editing.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ name, ...scopePayload }),
        })
        onSaved()
        onClose()
      } else {
        const expiresAt =
          expiresInDays === ''
            ? undefined
            : new Date(
                Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000,
              ).toISOString()

        const result = await apiFetch<{ data: { key: string } }>(basePath, {
          method: 'POST',
          body: JSON.stringify({ name, ...scopePayload, expiresAt }),
        })
        onSaved()
        onClose()
        onCreated(result.data.key)
      }
    } catch (err) {
      setErrorMessage(
        err instanceof ApiError ? err.message : 'Failed to save API key',
      )
    } finally {
      setSaving(false)
    }
  }

  const effectiveLifetime =
    expiresInDays === ''
      ? (policy?.defaultExpirationDays ?? null)
      : Number(expiresInDays)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {editing ? 'Edit API key' : 'Create API key'}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? 'Scope changes take effect on the next request. The secret is unchanged — use Rotate to replace it.'
              : 'The key acts as its owner. Scope it to the narrowest set of permissions and roles the client actually needs.'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="CI pipeline, CAD connector, …"
            />
          </div>

          {!editing && (
            <div className="space-y-2">
              <Label htmlFor="key-expiry">Expires in (days)</Label>
              <Input
                id="key-expiry"
                type="number"
                min={1}
                value={expiresInDays}
                onChange={(e) => setExpiresInDays(e.target.value)}
                placeholder={
                  policy?.defaultExpirationDays == null
                    ? 'Policy default'
                    : `Policy default: ${String(policy.defaultExpirationDays)}`
                }
              />
              <p className="text-xs text-muted-foreground">
                {effectiveLifetime === null
                  ? policy?.requireExpiration
                    ? 'The policy requires an expiry — enter one.'
                    : 'This key will not expire.'
                  : `Expires in ${String(effectiveLifetime)} days.`}
                {policy?.maxExpirationDays != null &&
                  ` Maximum allowed: ${String(policy.maxExpirationDays)} days.`}
              </p>
            </div>
          )}

          <div className="border-t border-slate-200 dark:border-slate-700 pt-4">
            <ApiKeyScopeEditor
              value={scope}
              onChange={setScope}
              scopableRoles={scopableRoles}
            />
          </div>

          {errorMessage && (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <AlertCircle className="w-4 h-4" />
              {errorMessage}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || name.trim().length === 0}
          >
            {saving ? 'Saving…' : editing ? 'Save changes' : 'Create key'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
