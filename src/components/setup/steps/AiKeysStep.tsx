// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  Loader2,
  Save,
  Sparkles,
  TestTube,
} from 'lucide-react'
import { useAiSettings } from '../hooks/useAiSettings'
import { strings } from '../strings'
import type { AiProviderType, AiSettingsForm } from '../hooks/useAiSettings'
import {
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@/components/ui'

const DEFAULT_MODELS: Record<AiProviderType, Array<string>> = {
  openai: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'o3', 'o4-mini'],
  anthropic: ['claude-opus-4-7', 'claude-sonnet-4-6'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash'],
  ollama: ['llama3.3', 'qwen2.5'],
}

const PROVIDER_LABELS: Record<AiProviderType, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Google Gemini',
  ollama: 'Ollama (local)',
}

interface AiKeysStepProps {
  onCompleted: () => void
}

export function AiKeysStep({ onCompleted }: AiKeysStepProps) {
  const [form, setForm] = useState<AiSettingsForm>({
    enabled: true,
    provider: 'anthropic',
    apiKey: '',
    model: DEFAULT_MODELS.anthropic[0] ?? '',
    baseURL: '',
  })

  const aiSettings = useAiSettings()

  const handleProviderChange = (provider: AiProviderType) => {
    setForm({
      ...form,
      provider,
      model: DEFAULT_MODELS[provider][0] ?? '',
      baseURL: provider === 'ollama' ? 'http://localhost:11434' : '',
    })
    aiSettings.reset()
  }

  const handleSaveAndContinue = async () => {
    const ok = await aiSettings.save(form)
    if (ok) onCompleted()
  }

  const canTest = form.apiKey.length > 0 || form.provider === 'ollama'
  const canSave = form.apiKey.length > 0 || form.provider === 'ollama'

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Sparkles className="w-6 h-6 text-slate-700 dark:text-slate-300" />
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
            {strings.steps.ai.title}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {strings.steps.ai.description}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="ai-provider">Provider</Label>
              <Select
                value={form.provider}
                onValueChange={(v) => handleProviderChange(v as AiProviderType)}
              >
                <SelectTrigger id="ai-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROVIDER_LABELS) as Array<AiProviderType>).map(
                    (p) => (
                      <SelectItem key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-model">Model</Label>
              <Select
                value={form.model}
                onValueChange={(v) => setForm({ ...form, model: v })}
              >
                <SelectTrigger id="ai-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DEFAULT_MODELS[form.provider].map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="ai-key">
              API key{' '}
              {form.provider === 'ollama' && (
                <span className="text-xs text-slate-500">(not required)</span>
              )}
            </Label>
            <Input
              id="ai-key"
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={form.provider === 'ollama' ? '—' : 'sk-…'}
              disabled={form.provider === 'ollama'}
            />
          </div>

          {form.provider === 'ollama' && (
            <div className="space-y-2">
              <Label htmlFor="ai-baseurl">Ollama base URL</Label>
              <Input
                id="ai-baseurl"
                value={form.baseURL ?? ''}
                onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                placeholder="http://localhost:11434"
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            <Switch
              id="ai-enabled"
              checked={form.enabled}
              onCheckedChange={(checked) =>
                setForm({ ...form, enabled: checked })
              }
            />
            <Label htmlFor="ai-enabled">Enable AI features</Label>
          </div>

          <div className="flex items-center gap-3 pt-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => aiSettings.testConnection(form)}
              disabled={!canTest || aiSettings.testing}
            >
              {aiSettings.testing ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <TestTube className="w-4 h-4 mr-2" />
              )}
              Test connection
            </Button>
            <Button
              onClick={handleSaveAndContinue}
              disabled={!canSave || aiSettings.saving}
            >
              {aiSettings.saving ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Save className="w-4 h-4 mr-2" />
              )}
              Save and continue
            </Button>

            {aiSettings.testStatus === 'success' && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle className="w-4 h-4" />
                {aiSettings.testMessage || 'Connected'}
              </span>
            )}
            {aiSettings.testStatus === 'error' && (
              <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                <AlertCircle className="w-4 h-4" />
                {aiSettings.testMessage}
              </span>
            )}
            {aiSettings.saveStatus === 'error' && (
              <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
                <AlertCircle className="w-4 h-4" />
                {aiSettings.saveMessage}
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
