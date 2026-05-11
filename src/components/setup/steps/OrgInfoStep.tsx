// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { useEffect, useState } from 'react'
import { Building2, CheckCircle, Loader2 } from 'lucide-react'
import { strings } from '../strings'
import { Button, Card, CardContent, Input, Label } from '@/components/ui'

interface OrgInfo {
  name: string
  primaryContact: string
  brandingColor: string
}

const DEFAULT_ORG_INFO: OrgInfo = {
  name: '',
  primaryContact: '',
  brandingColor: '#3b82f6',
}

interface OrgInfoStepProps {
  onCompleted: () => void
}

export function OrgInfoStep({ onCompleted }: OrgInfoStepProps) {
  const [form, setForm] = useState<OrgInfo>(DEFAULT_ORG_INFO)
  const [saving, setSaving] = useState(false)
  const [savedName, setSavedName] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/v1/admin/settings?key=org.info')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return
        const stored = json.data?.setting?.jsonValue as OrgInfo | undefined
        if (stored) {
          setForm({ ...DEFAULT_ORG_INFO, ...stored })
          setSavedName(stored.name)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleSave = async () => {
    if (!form.name.trim()) {
      setError('Organization name is required')
      return
    }
    setSaving(true)
    setError('')
    try {
      const response = await fetch('/api/v1/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'org.info',
          jsonValue: form,
          description: 'Organization information set during first-time setup',
        }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to save')
      }
      setSavedName(form.name)
      onCompleted()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Building2 className="w-6 h-6 text-slate-700 dark:text-slate-300" />
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
            {strings.steps.org.title}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {strings.steps.org.description}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="org-name">Organization name</Label>
            <Input
              id="org-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Acme Robotics"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-contact">
              Primary contact (email, optional)
            </Label>
            <Input
              id="org-contact"
              type="email"
              value={form.primaryContact}
              onChange={(e) =>
                setForm({ ...form, primaryContact: e.target.value })
              }
              placeholder="ops@acme-robotics.com"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="org-color">Brand color (optional)</Label>
            <div className="flex gap-2 items-center">
              <input
                id="org-color"
                type="color"
                value={form.brandingColor}
                onChange={(e) =>
                  setForm({ ...form, brandingColor: e.target.value })
                }
                className="h-10 w-16 rounded border border-slate-300 dark:border-slate-700 cursor-pointer"
              />
              <span className="text-sm text-slate-600 dark:text-slate-400 font-mono">
                {form.brandingColor}
              </span>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button onClick={handleSave} disabled={saving || !form.name.trim()}>
              {saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : null}
              {saving ? strings.actions.saving : 'Save and continue'}
            </Button>
            {savedName && !saving && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle className="w-4 h-4" />
                Saved as {savedName}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
