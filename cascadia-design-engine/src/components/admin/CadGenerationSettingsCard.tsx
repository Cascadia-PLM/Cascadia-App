// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  AlertCircle,
  AlertTriangle,
  Box,
  CheckCircle,
  Loader2,
  Save,
  SlidersHorizontal,
  TestTube,
} from 'lucide-react'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ResolvedCadGenerationSettings } from '@/cad-generation/settings-types'
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
  Switch,
} from '@/components/ui'
import { CAD_GENERATION_LIMITS } from '@/cad-generation/settings-types'
import { cadSettingsQuery } from '@/query/options/design-engine'
import { useResourceMutation } from '@/query'
import { apiFetch } from '@/api/client'

/**
 * Admin card for AI CAD generation.
 *
 * There is no key to enter: generation uses the AI provider configured in the
 * section above and the FreeCAD worker deployed alongside the CAD converter.
 * What an admin sets here is whether the pipeline runs, how many script
 * attempts the agent may spend per part, and how long one FreeCAD run may
 * take — and the test button proves a worker is actually consuming the queue.
 */
export function CadGenerationSettingsCard() {
  const { data, isPending } = useQuery(cadSettingsQuery())

  if (isPending) {
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

  if (!data) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center gap-2 py-12 text-red-600 dark:text-red-400">
          <AlertCircle className="w-4 h-4" />
          Failed to load CAD generation settings
        </CardContent>
      </Card>
    )
  }

  return (
    <CadGenerationSettingsForm
      settings={data.settings}
      aiConfigured={data.aiConfigured}
    />
  )
}

/**
 * The editable half, mounted once the server's answer is in hand.
 *
 * `settings` stays the authority for what is *saved* — the baseline the Save
 * button compares against reads straight from it, so a save refreshes it by
 * invalidating the cache rather than by patching state here. Only the fields
 * the admin is actively editing are local, seeded from the same answer.
 */
function CadGenerationSettingsForm({
  settings,
  aiConfigured,
}: {
  settings: ResolvedCadGenerationSettings
  aiConfigured: boolean
}) {
  const [enabled, setEnabled] = useState(settings.enabled)
  const [maxIterations, setMaxIterations] = useState(
    String(settings.maxIterations),
  )
  const [scriptTimeoutSeconds, setScriptTimeoutSeconds] = useState(
    String(settings.scriptTimeoutSeconds),
  )

  const [testing, setTesting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success'>('idle')
  const [testStatus, setTestStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  )
  const [testMessage, setTestMessage] = useState('')

  const parsedIterations = parseBounded(
    maxIterations,
    CAD_GENERATION_LIMITS.maxIterations,
  )
  const parsedTimeout = parseBounded(
    scriptTimeoutSeconds,
    CAD_GENERATION_LIMITS.scriptTimeoutSeconds,
  )
  const valid = parsedIterations !== null && parsedTimeout !== null

  const save = useResourceMutation<void, Error, void>({
    mutationFn: async () => {
      await apiFetch('/api/v1/admin/cad-settings', {
        method: 'POST',
        body: JSON.stringify({
          enabled,
          maxIterations: parsedIterations,
          scriptTimeoutSeconds: parsedTimeout,
        }),
      })
    },
    invalidates: ['admin'],
    onSuccess: () => {
      setSaveStatus('success')
      setTimeout(() => setSaveStatus('idle'), 3000)
    },
  })

  const handleTestWorker = async () => {
    try {
      setTesting(true)
      setTestStatus('idle')
      setTestMessage('')

      const response = await fetch('/api/v1/admin/cad-settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      const data = await response.json()
      if (!response.ok) {
        setTestStatus('error')
        setTestMessage(data.error?.message || 'FreeCAD worker test failed')
      } else {
        setTestStatus('success')
        setTestMessage(data.data?.message || 'FreeCAD worker responded.')
      }
    } catch (error) {
      console.error('Error testing the FreeCAD worker:', error)
      setTestStatus('error')
      setTestMessage((error as Error).message)
    } finally {
      setTesting(false)
    }
  }

  const hasChanges =
    enabled !== settings.enabled ||
    parsedIterations !== settings.maxIterations ||
    parsedTimeout !== settings.scriptTimeoutSeconds

  return (
    <>
      {/* No provider, nothing to call */}
      {!aiConfigured && (
        <Card className="border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30">
          <CardContent className="pt-6">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5" />
              <div>
                <p className="font-medium text-amber-900 dark:text-amber-100">
                  No AI provider configured
                </p>
                <p className="text-sm text-amber-700 dark:text-amber-300 mt-1">
                  CAD generation uses the AI provider configured above. Until
                  one is set and enabled, every generation fails before it
                  starts.
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
              <CardTitle>AI CAD Generation</CardTitle>
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
            Parts without a parametric template are modelled by the AI provider
            as FreeCAD Python scripts, executed headlessly by the FreeCAD
            worker. Parametric templates and mechanisms are unaffected by this
            switch.
          </CardDescription>
        </CardHeader>
      </Card>

      {/* Agent budget */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>Agent Budget</CardTitle>
          </div>
          <CardDescription>
            How hard the agent may try for one part. Each attempt is one model
            turn plus one FreeCAD run; most parts take one to three.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="cad-max-iterations">
              Maximum script attempts per part
            </Label>
            <Input
              id="cad-max-iterations"
              type="number"
              inputMode="numeric"
              min={CAD_GENERATION_LIMITS.maxIterations.min}
              max={CAD_GENERATION_LIMITS.maxIterations.max}
              step={1}
              value={maxIterations}
              onChange={(e) => setMaxIterations(e.target.value)}
              className="max-w-xs"
            />
            <p className="text-sm text-slate-500">
              {CAD_GENERATION_LIMITS.maxIterations.min}–
              {CAD_GENERATION_LIMITS.maxIterations.max}. The agent stops early
              once a run produces valid geometry.
              {parsedIterations === null && (
                <span className="text-red-600 dark:text-red-400">
                  {' '}
                  Enter a whole number in range.
                </span>
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="cad-script-timeout">Script timeout (seconds)</Label>
            <Input
              id="cad-script-timeout"
              type="number"
              inputMode="numeric"
              min={CAD_GENERATION_LIMITS.scriptTimeoutSeconds.min}
              max={CAD_GENERATION_LIMITS.scriptTimeoutSeconds.max}
              step={5}
              value={scriptTimeoutSeconds}
              onChange={(e) => setScriptTimeoutSeconds(e.target.value)}
              className="max-w-xs"
            />
            <p className="text-sm text-slate-500">
              {CAD_GENERATION_LIMITS.scriptTimeoutSeconds.min}–
              {CAD_GENERATION_LIMITS.scriptTimeoutSeconds.max}. Wall-clock
              budget for one FreeCAD run, on top of FreeCAD&apos;s own start-up.
              Raise it for parts with heavy booleans or lofts.
              {parsedTimeout === null && (
                <span className="text-red-600 dark:text-red-400">
                  {' '}
                  Enter a whole number in range.
                </span>
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Worker smoke test */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <TestTube className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>FreeCAD Worker</CardTitle>
          </div>
          <CardDescription>
            Runs a tiny script through the whole pipeline — queue, worker,
            FreeCAD, report — without storing anything. A worker that is not
            running shows up here as a timeout.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={handleTestWorker}
              disabled={testing}
            >
              {testing ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <TestTube className="w-4 h-4 mr-2" />
              )}
              {testing ? 'Waiting for the worker...' : 'Test FreeCAD worker'}
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
          <p className="text-sm text-slate-500 mt-3">
            Start it locally with{' '}
            <Badge variant="outline" className="font-mono">
              npm run freecad:worker:dev
            </Badge>
            , or deploy it beside the CAD converter — see{' '}
            <span className="font-mono">docs/features/cad-services.md</span>.
          </p>
        </CardContent>
      </Card>

      {/* Save */}
      <div className="flex items-center gap-3">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || !hasChanges || !valid}
        >
          {save.isPending ? (
            <Loader2 className="w-4 h-4 mr-2 animate-spin" />
          ) : (
            <Save className="w-4 h-4 mr-2" />
          )}
          {save.isPending ? 'Saving...' : 'Save Configuration'}
        </Button>
        {saveStatus === 'success' && (
          <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
            <CheckCircle className="w-4 h-4" />
            Settings saved successfully!
          </span>
        )}
        {save.error && (
          <span className="flex items-center gap-1 text-sm text-red-600 dark:text-red-400">
            <AlertCircle className="w-4 h-4" />
            {save.error.message}
          </span>
        )}
      </div>
    </>
  )
}

/** A whole number inside `range`, or null when the field is not one. */
function parseBounded(
  value: string,
  range: { min: number; max: number },
): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const parsed = Number(value)
  if (parsed < range.min || parsed > range.max) return null
  return parsed
}
