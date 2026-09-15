// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, CheckCircle, Plus, Wrench, X } from 'lucide-react'
import { strings } from '../strings'
import type { KnownToolSubtype, Tool } from '@/lib/items/types/tool'
import { itemCollectionQuery, useInvalidateResources } from '@/lib/query'
import { TOOL_SUBTYPES } from '@/lib/items/types/tool'
import { ToolForm } from '@/components/tools/ToolForm'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface ToolsStepProps {
  onCompleted: () => void
}

const STATUS_VARIANTS: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  available: 'success',
  in_use: 'default',
  maintenance: 'warning',
  retired: 'destructive',
}

function subtypeLabel(subtype?: string): string {
  if (!subtype) return 'Uncategorized'
  const known = TOOL_SUBTYPES[subtype as KnownToolSubtype] as
    { label: string } | undefined
  return known ? known.label : subtype
}

/** "Prusa Research MK4S" from whichever of the two is filled in. */
function makeAndModel(tool: Tool): string {
  return [tool.manufacturer, tool.model].filter(Boolean).join(' ')
}

export function ToolsStep({ onCompleted }: ToolsStepProps) {
  const invalidate = useInvalidateResources()
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // Existing tools, so re-running the wizard shows what's already there.
  const { data: tools = [] } = useQuery(
    itemCollectionQuery<Tool>({ itemType: 'Tool' }, 100),
  )

  const handleCreate = async (tool: Tool) => {
    setSaving(true)
    setError('')
    try {
      const response = await fetch('/api/v1/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...tool, itemType: 'Tool' }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to create tool')
      }
      await invalidate('items')
      // Collapse back to the list; the button re-opens a blank form.
      setShowForm(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Wrench className="w-6 h-6 text-slate-700 dark:text-slate-300" />
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
            {strings.steps.tools.title}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {strings.steps.tools.description}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-4">
            <div>
              <CardTitle className="text-base">
                {tools.length > 0
                  ? `${tools.length} tool${tools.length === 1 ? '' : 's'} on record`
                  : 'No tools yet'}
              </CardTitle>
              <CardDescription>
                Name, type, and subtype are all that's required — capabilities
                like build volume or spindle speed can be filled in later.
              </CardDescription>
            </div>
            {!showForm && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setError('')
                  setShowForm(true)
                }}
                className="shrink-0"
              >
                <Plus className="w-4 h-4 mr-2" />
                Add tool
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {tools.length > 0 && (
            <div className="space-y-1">
              {tools.map((tool) => (
                <div
                  key={tool.id}
                  className="flex items-center gap-3 px-3 py-2 rounded border border-slate-200 dark:border-slate-700"
                >
                  <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400 shrink-0" />
                  <span className="text-sm text-slate-900 dark:text-slate-100">
                    {tool.name || tool.itemNumber}
                  </span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {subtypeLabel(tool.toolSubtype)}
                  </span>
                  <span className="text-sm text-slate-500 dark:text-slate-400 truncate">
                    {makeAndModel(tool)}
                  </span>
                  {tool.state && (
                    <Badge
                      variant={STATUS_VARIANTS[tool.state] ?? 'default'}
                      className="ml-auto shrink-0"
                    >
                      {tool.state}
                    </Badge>
                  )}
                </div>
              ))}
            </div>
          )}

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          {showForm ? (
            <div className="border-t border-slate-200 dark:border-slate-800 pt-4">
              <ToolForm
                onSubmit={handleCreate}
                onCancel={() => {
                  setError('')
                  setShowForm(false)
                }}
                isSubmitting={saving}
              />
            </div>
          ) : (
            tools.length === 0 && (
              <button
                type="button"
                onClick={() => setShowForm(true)}
                className="w-full flex flex-col items-center gap-2 rounded border border-dashed border-slate-300 dark:border-slate-700 px-4 py-8 text-slate-500 dark:text-slate-400 hover:border-slate-400 dark:hover:border-slate-600 hover:text-slate-700 dark:hover:text-slate-200 transition-colors"
              >
                <Wrench className="w-6 h-6" />
                <span className="text-sm">
                  Add your first machine — a printer, mill, saw, or gauge
                </span>
              </button>
            )
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Button onClick={onCompleted}>
          Continue
          <ArrowRight className="w-4 h-4 ml-2" />
        </Button>
        {tools.length === 0 && (
          <span className="flex items-center gap-1 text-sm text-slate-500 dark:text-slate-400">
            <X className="w-4 h-4" />
            Skipping is fine — you can add tools later.
          </span>
        )}
      </div>
    </div>
  )
}
