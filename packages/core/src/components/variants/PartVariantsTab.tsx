// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Info } from 'lucide-react'
import { MakesEditor } from './MakesEditor'
import { OptionModelEditor } from './OptionModelEditor'
import { PartConfigurator } from './PartConfigurator'
import type { Design } from '@/lib/types/design'
import type { Part } from '@/lib/items/types/part'
import type { Make, OptionModel } from '@/lib/types/variants'
import type { MbomConfigurationInput } from '@/components/mbom/CreateMbomDialog'
import { CreateMbomDialog } from '@/components/mbom/CreateMbomDialog'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import {
  entityQuery,
  partVariantLintQuery,
  useResourceMutation,
} from '@/lib/query'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

const EMPTY_MODEL: OptionModel = { families: [], constraints: [] }

/**
 * The Variants tab of the part page. Appears once the part declares option
 * families (see `PartDetail`), and holds the option model, the named makes,
 * and the lint findings over both.
 *
 * Saves go through `PUT /api/v1/parts/:id`, the same route as any other part
 * field, so they need the edit lock the page holds in edit mode; the editors
 * are read-only otherwise. The server refuses a model change that strands a
 * conditioned BOM line, so a bad save comes back as a message, not as
 * inconsistent data.
 */
export function PartVariantsTab({
  part,
  branchId,
  isEditing,
}: {
  part: Part
  branchId?: string
  isEditing: boolean
}) {
  const { alert } = useAlertDialog()
  const partId = part.id!

  const [model, setModel] = useState<OptionModel>(
    part.optionModel ?? EMPTY_MODEL,
  )
  const [makes, setMakes] = useState<Array<Make>>(part.makes ?? [])
  const [dirty, setDirty] = useState(false)
  const [selections, setSelections] = useState<Record<string, string>>({})
  const [mbomConfig, setMbomConfig] = useState<MbomConfigurationInput | null>(
    null,
  )
  const { data: design } = useQuery(
    entityQuery<Design>(
      'designs',
      part.designId,
      'design',
      Boolean(part.designId),
    ),
  )

  // Re-seed from the server when the part reloads (a save elsewhere, a
  // context switch) and there is nothing unsaved here.
  useEffect(() => {
    if (!dirty) {
      setModel(part.optionModel ?? EMPTY_MODEL)
      setMakes(part.makes ?? [])
    }
  }, [part.optionModel, part.makes, dirty])

  useEffect(() => {
    if (!isEditing) setDirty(false)
  }, [isEditing])

  const lint = useQuery(partVariantLintQuery(partId, branchId))

  const save = useResourceMutation({
    mutationFn: () =>
      apiFetch(`/api/v1/parts/${partId}`, {
        method: 'PUT',
        body: JSON.stringify({ optionModel: model, makes }),
      }),
    invalidates: ['parts'],
    onSuccess: () => setDirty(false),
    onError: (error: Error) =>
      alert({
        title: 'Failed to save variant data',
        description: error.message,
        variant: 'destructive',
      }),
  })

  const errors = (lint.data ?? []).filter((f) => f.severity === 'error')
  const warnings = (lint.data ?? []).filter((f) => f.severity === 'warning')

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Configure</CardTitle>
            <CardDescription>
              Pick a value per family to see the BOM a configuration resolves
              to. Save the selections as a make, or derive a Manufacturing
              design from them.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PartConfigurator
              partId={partId}
              model={part.optionModel ?? model}
              selections={selections}
              onSelectionsChange={setSelections}
              branchId={branchId}
              makes={makes}
              onSaveAsMake={
                isEditing
                  ? (make) => {
                      setMakes([...makes, make])
                      setDirty(true)
                    }
                  : undefined
              }
              onCreateMbom={
                design
                  ? (chosen) => {
                      const matching = makes.find(
                        (m) =>
                          Object.keys(m.selections).length ===
                            Object.keys(chosen).length &&
                          Object.entries(m.selections).every(
                            ([k, v]) => chosen[k] === v,
                          ),
                      )
                      setMbomConfig({
                        rootItemId: partId,
                        rootItemNumber: part.itemNumber ?? '',
                        makeCode: matching?.code,
                        selections: chosen,
                      })
                    }
                  : undefined
              }
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>Option model</CardTitle>
                <CardDescription>
                  The families a configuration selects from, and the constraints
                  between them. BOM lines reference these.
                </CardDescription>
              </div>
              {isEditing && (
                <Button
                  type="button"
                  size="sm"
                  disabled={!dirty || save.isPending}
                  onClick={() => save.mutate()}
                >
                  {save.isPending ? 'Saving…' : 'Save variant data'}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <OptionModelEditor
              value={model}
              isEditing={isEditing}
              onChange={(next) => {
                setModel(next)
                setDirty(true)
              }}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Makes</CardTitle>
            <CardDescription>
              Named, complete configurations of this part. A make revisions with
              the part; deriving a Manufacturing design from one gives it a part
              number of its own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MakesEditor
              model={model}
              value={makes}
              isEditing={isEditing}
              onLoad={(make) => setSelections({ ...make.selections })}
              onChange={(next) => {
                setMakes(next)
                setDirty(true)
              }}
            />
          </CardContent>
        </Card>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Checks
              {lint.data && (
                <Badge
                  variant={
                    errors.length > 0
                      ? 'destructive'
                      : warnings.length > 0
                        ? 'warning'
                        : 'success'
                  }
                >
                  {errors.length > 0
                    ? `${errors.length} error${errors.length === 1 ? '' : 's'}`
                    : warnings.length > 0
                      ? `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`
                      : 'clean'}
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              Whether the model, the makes and the BOM lines agree.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {lint.isPending ? (
              <p className="text-sm text-slate-500">Checking…</p>
            ) : (lint.data ?? []).length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                Nothing to report.
              </p>
            ) : (
              <ul className="space-y-2">
                {(lint.data ?? []).map((finding, i) => (
                  <li key={i} className="flex gap-2 text-sm">
                    {finding.severity === 'error' ? (
                      <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-red-600 dark:text-red-400" />
                    ) : (
                      <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" />
                    )}
                    <span>{finding.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {design && mbomConfig && (
        <CreateMbomDialog
          open
          onOpenChange={(open) => {
            if (!open) setMbomConfig(null)
          }}
          sourceDesignId={design.id}
          sourceDesignCode={design.code}
          sourceDesignName={design.name}
          configuration={mbomConfig}
        />
      )}
    </div>
  )
}
