// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Bot,
  CheckCircle,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
  TestTube,
} from 'lucide-react'
import { useState } from 'react'
import type { AiProviderSettings, AiSettingsEnvVars } from '@/lib/query'
import type { AiProviderType } from '@/lib/ai/model-catalog'
import {
  AI_PROVIDERS,
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_BASE_URL,
  PROVIDER_LABELS,
  isAiProviderType,
} from '@/lib/ai/model-catalog'
import { useAiModels, withSelectedModel } from '@/lib/hooks/useAiModels'
import { PageContainer } from '@/components/layout'
import { Slot } from '@/lib/ui/slot-registry'
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
import { aiSettingsQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/admin/ai')({
  component: AISettingsPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(aiSettingsQuery()),
})

interface AISettings {
  id?: string
  enabled: boolean
  provider: AiProviderType
  apiKey: string
  model: string
  baseURL?: string
}

function toProviderType(value: string | undefined): AiProviderType {
  return isAiProviderType(value) ? value : 'openai'
}

function toFormState(record: AiProviderSettings | null): AISettings {
  const provider = toProviderType(record?.provider)
  return {
    id: record?.id,
    enabled: record?.enabled ?? false,
    provider,
    apiKey: record?.config.apiKey ?? '',
    model: record?.config.model ?? DEFAULT_MODEL[provider],
    baseURL: record?.config.baseURL ?? '',
  }
}

function AISettingsPage() {
  const { data, isPending } = useQuery(aiSettingsQuery())

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center gap-3">
        <Bot className="w-8 h-8 text-slate-700 dark:text-slate-300" />
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            AI Assistant
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Configure the AI chatbot provider and settings
          </p>
        </div>
      </div>

      {isPending || !data ? (
        <Card>
          <CardContent className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400 mr-2" />
            <span className="text-slate-600 dark:text-slate-400">
              Loading AI settings...
            </span>
          </CardContent>
        </Card>
      ) : (
        <AIProviderForm
          initialSettings={data.settings}
          envVarsDetected={data.envVars}
        />
      )}

      <Slot name="admin-ai-settings-sections" props={{}} />
    </PageContainer>
  )
}

function AIProviderForm({
  initialSettings,
  envVarsDetected,
}: {
  initialSettings: AiProviderSettings | null
  envVarsDetected: AiSettingsEnvVars
}) {
  const invalidate = useInvalidateResources()
  const [settings, setSettings] = useState<AISettings>(() =>
    toFormState(initialSettings),
  )
  const [originalSettings, setOriginalSettings] = useState<AISettings | null>(
    () => (initialSettings ? toFormState(initialSettings) : null),
  )
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  )
  const [testStatus, setTestStatus] = useState<
    'idle' | 'success' | 'error' | 'testing'
  >('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [testMessage, setTestMessage] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  // A key is reachable server-side when one is stored for this provider or
  // present in the environment, even though the form only ever sees it masked.
  const hasServerCredentials =
    (initialSettings?.provider === settings.provider &&
      !!initialSettings.config.apiKey) ||
    (settings.provider === 'openai' && envVarsDetected.openai) ||
    (settings.provider === 'anthropic' && envVarsDetected.anthropic)

  const models = useAiModels({
    provider: settings.provider,
    apiKey: settings.apiKey,
    baseURL: settings.baseURL,
    hasServerCredentials,
  })
  const modelOptions = withSelectedModel(models.options, settings.model)

  const handleProviderChange = (provider: AiProviderType) => {
    setSettings((prev) => ({
      ...prev,
      provider,
      model: DEFAULT_MODEL[provider],
      baseURL: provider === 'ollama' ? DEFAULT_OLLAMA_BASE_URL : '',
    }))
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      setSaveStatus('idle')
      setErrorMessage('')

      const result = await apiFetch<{ data: { settings: { id: string } } }>(
        '/api/v1/admin/ai-settings',
        {
          method: 'POST',
          body: JSON.stringify({
            enabled: settings.enabled,
            provider: settings.provider,
            config: {
              provider: settings.provider,
              apiKey: settings.apiKey,
              model: settings.model,
              baseURL: settings.baseURL || undefined,
            },
          }),
        },
      )

      const id = result.data.settings.id
      setOriginalSettings({ ...settings, id })
      setSettings((prev) => ({ ...prev, id }))
      setSaveStatus('success')
      await invalidate('admin')
      setTimeout(() => setSaveStatus('idle'), 3000)
    } catch (error) {
      console.error('Error saving AI settings:', error)
      setSaveStatus('error')
      setErrorMessage((error as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const handleTestConnection = async () => {
    try {
      setTesting(true)
      setTestStatus('testing')
      setTestMessage('')

      const result = await apiFetch<{ data: { message?: string } }>(
        '/api/v1/admin/ai-settings/test',
        {
          method: 'POST',
          body: JSON.stringify({
            provider: settings.provider,
            apiKey: settings.apiKey,
            model: settings.model,
            baseURL: settings.baseURL || undefined,
          }),
        },
      )

      setTestStatus('success')
      setTestMessage(result.data.message ?? 'Connection successful!')
      setTimeout(() => setTestStatus('idle'), 5000)
    } catch (error) {
      console.error('Error testing AI connection:', error)
      setTestStatus('error')
      setTestMessage((error as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const hasChanges =
    originalSettings === null ||
    settings.enabled !== originalSettings.enabled ||
    settings.provider !== originalSettings.provider ||
    settings.apiKey !== originalSettings.apiKey ||
    settings.model !== originalSettings.model ||
    settings.baseURL !== originalSettings.baseURL

  const canTest =
    settings.apiKey.length > 0 ||
    settings.provider === 'ollama' ||
    (settings.provider === 'openai' && envVarsDetected.openai) ||
    (settings.provider === 'anthropic' && envVarsDetected.anthropic)

  return (
    <>
      {/* Environment Variables Info */}
      {(envVarsDetected.openai || envVarsDetected.anthropic) && (
        <Card className="border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950/30">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <Sparkles className="w-5 h-5 text-blue-600 dark:text-blue-400 mt-0.5" />
              <div>
                <p className="font-medium text-blue-900 dark:text-blue-100">
                  Environment variables detected
                </p>
                <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                  {envVarsDetected.openai && (
                    <span className="mr-3">
                      <Badge variant="outline" className="mr-1">
                        OPENAI_API_KEY
                      </Badge>
                      configured
                    </span>
                  )}
                  {envVarsDetected.anthropic && (
                    <span>
                      <Badge variant="outline" className="mr-1">
                        ANTHROPIC_API_KEY
                      </Badge>
                      configured
                    </span>
                  )}
                </p>
                <p className="text-sm text-blue-600 dark:text-blue-400 mt-2">
                  Database settings will override environment variables when
                  enabled.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Enable/Disable AI */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-slate-600 dark:text-slate-400" />
              <CardTitle>AI Assistant Status</CardTitle>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`text-sm ${settings.enabled ? 'text-green-600 dark:text-green-400' : 'text-slate-500'}`}
              >
                {settings.enabled ? 'Enabled' : 'Disabled'}
              </span>
              <Switch
                checked={settings.enabled}
                onCheckedChange={(checked) =>
                  setSettings((prev) => ({ ...prev, enabled: checked }))
                }
              />
            </div>
          </div>
          <CardDescription>
            Enable or disable the AI chatbot for all users
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Provider Configuration */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Bot className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>Provider Configuration</CardTitle>
          </div>
          <CardDescription>
            Select your AI provider and configure API credentials
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Provider Selection */}
          <div className="space-y-2">
            <Label htmlFor="provider">Provider</Label>
            <Select
              value={settings.provider}
              onValueChange={(value) =>
                handleProviderChange(toProviderType(value))
              }
            >
              <SelectTrigger id="provider" className="w-full max-w-md">
                <SelectValue placeholder="Select a provider" />
              </SelectTrigger>
              <SelectContent>
                {AI_PROVIDERS.map((key) => (
                  <SelectItem key={key} value={key}>
                    {PROVIDER_LABELS[key]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* API Key */}
          {settings.provider !== 'ollama' && (
            <div className="space-y-2">
              <Label htmlFor="apiKey">API Key</Label>
              <div className="flex gap-2 max-w-md">
                <div className="relative flex-1">
                  {/* Hidden input to prevent browser autofill from targeting the header search bar */}
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
                    id="apiKey"
                    name="api-key-field"
                    type={showApiKey ? 'text' : 'password'}
                    placeholder={`Enter your ${PROVIDER_LABELS[settings.provider]} API key`}
                    value={settings.apiKey}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        apiKey: e.target.value,
                      }))
                    }
                    autoComplete="new-password"
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowApiKey(!showApiKey)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-400"
                  >
                    {showApiKey ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
              {((settings.provider === 'openai' && envVarsDetected.openai) ||
                (settings.provider === 'anthropic' &&
                  envVarsDetected.anthropic)) &&
                !settings.apiKey && (
                  <p className="text-sm text-slate-500">
                    Leave blank to use environment variable
                  </p>
                )}
            </div>
          )}

          {/* Model Selection */}
          <div className="space-y-2">
            <Label htmlFor="model">Model</Label>
            <div className="flex items-center gap-2 max-w-md">
              <Select
                value={settings.model}
                onValueChange={(value) =>
                  setSettings((prev) => ({ ...prev, model: value }))
                }
              >
                <SelectTrigger id="model" className="flex-1">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.label === model.id
                        ? model.id
                        : `${model.label} — ${model.id}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={models.refresh}
                disabled={models.isFetching}
                title="Refresh model list from provider"
                aria-label="Refresh model list from provider"
              >
                <RefreshCw
                  className={`w-4 h-4 ${models.isFetching ? 'animate-spin' : ''}`}
                />
              </Button>
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {models.isFetching
                ? 'Loading models…'
                : models.isLive
                  ? `${modelOptions.length} models available from ${models.source}.`
                  : `Showing the built-in list. ${models.fallbackReason ?? ''}`}
            </p>
          </div>

          {/* Base URL (for OpenAI-compatible or Ollama) */}
          {(settings.provider === 'openai' ||
            settings.provider === 'ollama') && (
            <div className="space-y-2">
              <Label htmlFor="baseURL">
                Base URL{' '}
                <span className="text-slate-400 font-normal">(optional)</span>
              </Label>
              <Input
                id="baseURL"
                type="text"
                placeholder={
                  settings.provider === 'ollama'
                    ? 'http://localhost:11434'
                    : 'https://api.openai.com/v1'
                }
                value={settings.baseURL}
                onChange={(e) =>
                  setSettings((prev) => ({
                    ...prev,
                    baseURL: e.target.value,
                  }))
                }
                className="max-w-md"
              />
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {settings.provider === 'ollama'
                  ? 'URL of your local Ollama instance'
                  : 'Custom endpoint for OpenAI-compatible APIs (e.g., Azure OpenAI)'}
              </p>
            </div>
          )}

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

      {/* Save Button */}
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
