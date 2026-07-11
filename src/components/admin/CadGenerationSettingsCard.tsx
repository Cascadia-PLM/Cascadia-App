// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import {
  AlertCircle,
  Box,
  CheckCircle,
  Eye,
  EyeOff,
  Loader2,
  Save,
  Sparkles,
  TestTube,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CadProvider } from '@/lib/cad-generation/settings-types'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@/components/ui'
import { CAD_PROVIDERS } from '@/lib/cad-generation/settings-types'

/**
 * Admin card for configuring the CAD generation (Zoo Text-to-CAD) API key.
 *
 * Mirrors the AI provider settings pattern: DB-stored + encrypted at rest, with
 * an env-var (`ZOO_API_KEY`) fallback. The secret is never prefilled into the
 * editable field — the API key input starts empty and a "Key configured" badge
 * indicates a saved key; saving with a blank field preserves the stored key.
 */
export function CadGenerationSettingsCard() {
  const [provider, setProvider] = useState<CadProvider>('zoo')
  const [enabled, setEnabled] = useState(false)
  const [originalEnabled, setOriginalEnabled] = useState(false)
  const [apiKey, setApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [apiKeyPreview, setApiKeyPreview] = useState<string | undefined>()
  const [showApiKey, setShowApiKey] = useState(false)
  const [envDetected, setEnvDetected] = useState(false)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  )
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [testMessage, setTestMessage] = useState('')

  useEffect(() => {
    void loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      setLoading(true)
      const response = await fetch('/api/v1/admin/cad-settings')
      if (response.ok) {
        const data = await response.json()
        const s = data.data?.settings
        if (s) {
          setProvider(s.provider ?? 'zoo')
          setEnabled(s.enabled ?? false)
          setOriginalEnabled(s.enabled ?? false)
          setHasApiKey(s.hasApiKey ?? false)
          setApiKeyPreview(s.apiKeyPreview)
        }
        setEnvDetected(data.data?.envVars?.zoo ?? false)
      }
    } catch (error) {
      console.error('Error loading CAD generation settings:', error)
      setErrorMessage('Failed to load CAD generation settings')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      setSaveStatus('idle')
      setErrorMessage('')

      const response = await fetch('/api/v1/admin/cad-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled,
          provider,
          config: {
            provider,
            // Only send a key when the admin typed one; blank preserves the
            // stored key server-side.
            apiKey: apiKey || undefined,
          },
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(
          error.error?.message || 'Failed to save CAD generation settings',
        )
      }

      const data = await response.json()
      const s = data.data?.settings
      if (s) {
        setHasApiKey(s.hasApiKey ?? false)
        setApiKeyPreview(s.apiKeyPreview)
      }
      setOriginalEnabled(enabled)
      setApiKey('')
      setSaveStatus('success')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch (error) {
      console.error('Error saving CAD generation settings:', error)
      setSaveStatus('error')
      setErrorMessage((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleTestConnection = async () => {
    try {
      setTesting(true)
      setTestStatus('idle')
      setTestMessage('')

      const response = await fetch('/api/v1/admin/cad-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider, apiKey: apiKey || undefined }),
      })

      const data = await response.json()
      if (!response.ok) {
        setTestStatus('error')
        setTestMessage(data.error?.message || 'Connection test failed')
      } else {
        setTestStatus('success')
        setTestMessage(data.data?.message || 'Connection successful!')
        setTimeout(() => setTestStatus('idle'), 5000)
      }
    } catch (error) {
      console.error('Error testing Zoo connection:', error)
      setTestStatus('error')
      setTestMessage((error as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const hasChanges = enabled !== originalEnabled || apiKey.length > 0
  const canTest = apiKey.length > 0 || hasApiKey || envDetected

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400 mr-2" />
          <span className="text-slate-600 dark:text-slate-400">
            Loading CAD generation settings...
          </span>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      {/* Environment variable info */}
      {envDetected && (
        <Card className="border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5" />
              <div>
                <p className="font-medium text-blue-900 dark:text-blue-100">
                  Environment variable detected
                </p>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  <Badge variant="outline" className="mr-1">
                    ZOO_API_KEY
                  </Badge>
                  configured
                </p>
                <p className="text-sm text-blue-600 dark:text-blue-400 mt-2">
                  A key saved here (and enabled) overrides the environment
                  variable.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Enable/Disable */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Box className="w-5 h-5 text-slate-600 dark:text-slate-400" />
              <CardTitle>CAD Generation Status</CardTitle>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`text-sm ${enabled ? 'text-green-600 dark:text-green-400' : 'text-slate-500'}`}
              >
                {enabled ? 'Enabled' : 'Disabled'}
              </span>
              <Switch checked={enabled} onCheckedChange={setEnabled} />
            </div>
          </div>
          <CardDescription>
            Use the stored key for Text-to-CAD generation in the design engine.
            When disabled, the app falls back to the ZOO_API_KEY environment
            variable.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Provider configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Box className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>Provider Configuration</CardTitle>
          </div>
          <CardDescription>
            Select your CAD generation provider and configure API credentials
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Provider */}
          <div className="space-y-2">
            <Label htmlFor="cad-provider">Provider</Label>
            <Select
              value={provider}
              onValueChange={(value) => setProvider(value as CadProvider)}
            >
              <SelectTrigger id="cad-provider" className="w-full max-w-md">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {(
                  Object.entries(CAD_PROVIDERS) as Array<[CadProvider, string]>
                ).map(([key, label]) => (
                  <SelectItem key={key} value={key}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* API Key */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="cad-api-key">API Key</Label>
              {hasApiKey && (
                <Badge variant="outline" className="text-green-600">
                  Key configured
                </Badge>
              )}
            </div>
            <div className="relative flex-1 max-w-md">
              {/* Hidden input to prevent browser autofill targeting the header search bar */}
              <input
                type="text"
                name="prevent-autofill"
                autoComplete="username"
                style={{
                  position: 'absolute',
                  opacity: 0,
                  pointerEvents: 'none',
                  height: 0,
                  width: 0,
                }}
                tabIndex={-1}
                aria-hidden="true"
              />
              <Input
                id="cad-api-key"
                name="cad-api-key-field"
                type={showApiKey ? 'text' : 'password'}
                placeholder={
                  hasApiKey
                    ? 'Leave blank to keep the saved key'
                    : `Enter your ${CAD_PROVIDERS[provider]} API key`
                }
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                autoComplete="new-password"
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowApiKey(!showApiKey)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showApiKey ? (
                  <EyeOff className="w-4 h-4" />
                ) : (
                  <Eye className="w-4 h-4" />
                )}
              </button>
            </div>
            {hasApiKey && apiKeyPreview && !apiKey && (
              <p className="text-sm text-slate-500">
                Saved key: <span className="font-mono">{apiKeyPreview}</span>
              </p>
            )}
          </div>

          {/* Test Connection */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={!canTest || testing}
            >
              {testing ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <TestTube className="w-4 h-4 mr-2" />
              )}
              {testing ? 'Testing...' : 'Test Connection'}
            </Button>
            {testStatus === 'success' && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle className="w-4 h-4" />
                {testMessage}
              </span>
            )}
            {testStatus === 'error' && (
              <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                <AlertCircle className="w-4 h-4" />
                {testMessage}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button onClick={handleSave} disabled={saving || !hasChanges}>
          {saving ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {saving ? 'Saving...' : 'Save Configuration'}
        </Button>
        {saveStatus === 'success' && (
          <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
            <CheckCircle className="w-4 h-4" />
            Settings saved successfully!
          </span>
        )}
        {saveStatus === 'error' && (
          <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="w-4 h-4" />
            {errorMessage}
          </span>
        )}
      </div>
    </>
  )
}
