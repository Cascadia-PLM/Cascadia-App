// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  ExternalLink,
  RotateCcw,
  Save,
} from 'lucide-react'
import type { ItemTypePermissions, WorkflowsByChangeType } from '@/lib/query'
import { PageContainer } from '@/components/layout'
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
} from '@/components/ui'
import { getNumberingInfo } from '@/lib/items/numbering/format'
import { resolveLifecycleType } from '@/lib/workflows/normalize'
import {
  itemTypeConfigQuery,
  lifecycleListQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/admin/item-types/$itemType')({
  component: ItemTypeConfigEditPage,
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(itemTypeConfigQuery(params.itemType)),
      queryClient.ensureQueryData(lifecycleListQuery()),
    ])
  },
})

const CHANGE_ORDER_TYPES = ['ECO', 'ECN', 'Deviation', 'MCO', 'XCO'] as const

const NO_PERMISSIONS: ItemTypePermissions = {
  create: [],
  read: [],
  update: [],
  delete: [],
}

function ItemTypeConfigEditPage() {
  const { itemType } = Route.useParams()
  const invalidate = useInvalidateResources()

  // Read-only view of the code-defined numbering scheme for this item type.
  const numbering = getNumberingInfo(itemType)

  const {
    data: detail,
    isPending,
    error: loadError,
  } = useQuery(itemTypeConfigQuery(itemType))
  const { data: definitions = [] } = useQuery(lifecycleListQuery())

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  // Form state
  const [label, setLabel] = useState('')
  const [pluralLabel, setPluralLabel] = useState('')
  const [icon, setIcon] = useState('')
  const [lifecycleDefinitionId, setLifecycleDefinitionId] = useState<
    string | null
  >(null)
  const [permissions, setPermissions] =
    useState<ItemTypePermissions>(NO_PERMISSIONS)
  const [workflowsByChangeType, setWorkflowsByChangeType] =
    useState<WorkflowsByChangeType>({})

  // Item lifecycles are the non-Driving kinds (Driven and Free);
  // Driving definitions are the change-order workflows
  const availableLifecycles = useMemo(
    () => definitions.filter((w) => resolveLifecycleType(w) !== 'Driving'),
    [definitions],
  )
  const availableWorkflows = useMemo(
    () => definitions.filter((w) => resolveLifecycleType(w) === 'Driving'),
    [definitions],
  )

  const hasRuntimeConfig = detail?.runtimeConfig != null
  const runtimeConfigVersion = detail?.runtimeConfig?.version ?? 0
  const codeConfig = detail?.codeConfig ?? null

  // The stored values are seeded into the form once per saved revision, so an
  // ordinary background refetch never overwrites edits in progress while a
  // save or a reset-to-code still re-seeds.
  const [seededRevision, setSeededRevision] = useState<string | null>(null)
  const revision = detail ? `${itemType}:${runtimeConfigVersion}` : null

  useEffect(() => {
    if (!detail || revision === null || revision === seededRevision) return

    const overrides = detail.runtimeConfig?.config
    const base = overrides ?? detail.mergedConfig ?? detail.codeConfig

    setLabel(base.label ?? '')
    setPluralLabel(base.pluralLabel ?? '')
    setIcon(base.icon ?? '')
    setLifecycleDefinitionId(
      base.lifecycleDefinitionId ??
        detail.codeConfig.lifecycleDefinitionId ??
        null,
    )
    setPermissions(base.permissions ?? detail.codeConfig.permissions)
    setWorkflowsByChangeType(overrides?.workflowsByChangeType ?? {})
    setSeededRevision(revision)
  }, [detail, revision, seededRevision])

  const selectedLifecycle =
    availableLifecycles.find((l) => l.id === lifecycleDefinitionId) ?? null

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSuccessMessage(null)

    try {
      const config: Record<string, unknown> = {
        label,
        pluralLabel,
        icon,
        lifecycleDefinitionId: lifecycleDefinitionId || null,
        permissions,
      }

      // Include workflowsByChangeType for ChangeOrder
      if (itemType === 'ChangeOrder') {
        config.workflowsByChangeType = workflowsByChangeType
      }

      await apiFetch('/api/v1/admin/item-type-configs', {
        method: 'POST',
        body: JSON.stringify({ itemType, config }),
      })

      setSuccessMessage('Configuration saved successfully!')
      await invalidate('admin')
      setTimeout(() => setSuccessMessage(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSaving(false)
    }
  }

  const handleResetToCode = async () => {
    if (
      !window.confirm(
        'Reset to code defaults? This will delete the runtime configuration and cannot be undone.',
      )
    ) {
      return
    }

    setSaving(true)
    setError(null)
    setSuccessMessage(null)

    try {
      await apiFetch(`/api/v1/admin/item-type-configs/${itemType}`, {
        method: 'DELETE',
      })

      setSuccessMessage('Configuration reset to code defaults!')
      await invalidate('admin')
      setTimeout(() => setSuccessMessage(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSaving(false)
    }
  }

  const updatePermission = (
    action: keyof ItemTypePermissions,
    value: string,
  ) => {
    const roles = value
      .split(',')
      .map((r) => r.trim())
      .filter(Boolean)
    setPermissions({ ...permissions, [action]: roles })
  }

  const getStateColorClass = (color?: string) => {
    const colorMap: Record<string, string> = {
      gray: 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
      blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
      green:
        'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
      yellow:
        'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
      red: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
    }
    return colorMap[color || 'gray'] || colorMap.gray
  }

  if (isPending || seededRevision === null) {
    return (
      <PageContainer maxWidth="wide">
        <p className="text-slate-600 dark:text-slate-400">
          {loadError ? loadError.message : 'Loading configuration...'}
        </p>
      </PageContainer>
    )
  }

  const errorMessage = error ?? loadError?.message ?? null

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/admin/item-types">
            <Button variant="outline" size="sm">
              <ArrowLeft className="w-4 h-4 mr-2" />
              Back
            </Button>
          </Link>
          <div>
            <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
              Configure {label || itemType}
            </h1>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              Type: <code className="text-sm">{itemType}</code>
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {hasRuntimeConfig && (
            <Button
              variant="outline"
              onClick={handleResetToCode}
              disabled={saving}
            >
              <RotateCcw className="w-4 h-4 mr-2" />
              Reset to Code
            </Button>
          )}
          <Button onClick={handleSave} disabled={saving}>
            <Save className="w-4 h-4 mr-2" />
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </div>

      {/* Error message */}
      {errorMessage && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {errorMessage}
          </div>
        </div>
      )}

      {/* Success message */}
      {successMessage && (
        <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded dark:bg-green-900/20 dark:border-green-800 dark:text-green-400">
          <div className="flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            {successMessage}
          </div>
        </div>
      )}

      {/* Status banner */}
      <Card className="bg-blue-50 border-blue-200 dark:bg-blue-900/20 dark:border-blue-800">
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              {hasRuntimeConfig ? (
                <>
                  <Badge className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400">
                    Runtime Override Active (v{runtimeConfigVersion})
                  </Badge>
                  <span className="text-sm text-blue-800 dark:text-blue-200">
                    These settings override code defaults
                  </span>
                </>
              ) : (
                <>
                  <Badge variant="secondary">Using Code Defaults</Badge>
                  <span className="text-sm text-blue-800 dark:text-blue-200">
                    Save to create runtime override
                  </span>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Basic Configuration */}
      <Card>
        <CardHeader>
          <CardTitle>Basic Configuration</CardTitle>
          <CardDescription>
            Labels and display settings for the item type
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="label">Label (Singular)</Label>
              <Input
                id="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Part"
              />
              {codeConfig && (
                <p className="text-xs text-slate-500">
                  Code default: {codeConfig.label}
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="pluralLabel">Label (Plural)</Label>
              <Input
                id="pluralLabel"
                value={pluralLabel}
                onChange={(e) => setPluralLabel(e.target.value)}
                placeholder="Parts"
              />
              {codeConfig && (
                <p className="text-xs text-slate-500">
                  Code default: {codeConfig.pluralLabel}
                </p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="icon">Icon Name</Label>
            <Input
              id="icon"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              placeholder="Package"
            />
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Lucide icon name (e.g., Package, FileText, Settings).{' '}
              {codeConfig && <span>Code default: {codeConfig.icon}</span>}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Numbering Scheme (read-only) */}
      <Card>
        <CardHeader>
          <CardTitle>Item Numbering</CardTitle>
          <CardDescription>
            How item numbers are generated for this type. Defined in code (
            <code className="text-xs">src/lib/items/numbering/schemes.ts</code>
            ).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {numbering ? (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-slate-600 dark:text-slate-400">
                  Example
                </span>
                <code className="text-base font-mono bg-slate-100 dark:bg-slate-800 px-3 py-1 rounded">
                  {numbering.example ?? '—'}
                </code>
                <Badge variant="secondary">
                  {numbering.allowManualEntry
                    ? 'Manual entry allowed'
                    : 'Always auto-generated'}
                </Badge>
                {numbering.familyVariants.enabled && (
                  <Badge variant="secondary">
                    Family variants (e.g. {numbering.familyVariants.example})
                  </Badge>
                )}
              </div>
              <div className="space-y-2">
                <Label>Pattern</Label>
                <ol className="space-y-1.5">
                  {numbering.segments.map((seg, i) => (
                    <li
                      key={i}
                      className="flex items-start gap-2 text-sm text-slate-700 dark:text-slate-300"
                    >
                      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs dark:bg-slate-700">
                        {i + 1}
                      </span>
                      <span>{seg.description}</span>
                    </li>
                  ))}
                </ol>
                <p className="text-xs text-slate-500">
                  Segments are joined with{' '}
                  <code className="text-xs">"{numbering.separator}"</code>.
                </p>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-600 dark:text-slate-400">
              No numbering scheme is defined for this item type.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Permissions */}
      <Card>
        <CardHeader>
          <CardTitle>Permissions</CardTitle>
          <CardDescription>
            Role-based access control for this item type
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(['create', 'read', 'update', 'delete'] as const).map((action) => (
            <div key={action} className="space-y-2">
              <Label htmlFor={`${action}Permissions`} className="capitalize">
                {action} Permissions
              </Label>
              <Input
                id={`${action}Permissions`}
                value={permissions[action].join(', ')}
                onChange={(e) => updatePermission(action, e.target.value)}
                placeholder={action === 'read' ? '*' : 'Admin, Engineer'}
              />
              {codeConfig && (
                <p className="text-xs text-slate-500">
                  Code default:{' '}
                  {codeConfig.permissions[action].join(', ') || '(none)'}
                </p>
              )}
            </div>
          ))}
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Enter comma-separated role names. Use <code>*</code> for all roles.
          </p>
        </CardContent>
      </Card>

      {/* Lifecycle Assignment - not shown for ChangeOrder as they use workflows */}
      {itemType !== 'ChangeOrder' && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Lifecycle Assignment</CardTitle>
                <CardDescription>
                  Select the lifecycle that controls states and transitions for
                  this item type
                </CardDescription>
              </div>
              {selectedLifecycle && (
                <Link
                  to="/lifecycles/$id"
                  params={{ id: selectedLifecycle.id }}
                >
                  <Button variant="outline" size="sm">
                    <ExternalLink className="w-4 h-4 mr-2" />
                    Edit Lifecycle
                  </Button>
                </Link>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>Lifecycle</Label>
              <Select
                value={lifecycleDefinitionId || '__none__'}
                onValueChange={(value) =>
                  setLifecycleDefinitionId(value === '__none__' ? null : value)
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a lifecycle..." />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">
                    No lifecycle assigned
                  </SelectItem>
                  {availableLifecycles.map((lifecycle) => (
                    <SelectItem key={lifecycle.id} value={lifecycle.id}>
                      {lifecycle.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {codeConfig?.lifecycleDefinitionId && (
                <p className="text-xs text-slate-500">
                  Code default:{' '}
                  {availableLifecycles.find(
                    (l) => l.id === codeConfig.lifecycleDefinitionId,
                  )?.name || codeConfig.lifecycleDefinitionId}
                </p>
              )}
            </div>

            {/* Show selected lifecycle states (read-only) */}
            {selectedLifecycle && (
              <div className="space-y-2">
                <Label className="text-slate-600 dark:text-slate-400">
                  States in "{selectedLifecycle.name}"
                </Label>
                <div className="flex flex-wrap gap-2">
                  {selectedLifecycle.states.map((state) => (
                    <Badge
                      key={state.id}
                      className={`${getStateColorClass(state.color)} text-xs`}
                    >
                      {state.name}
                      {state.isInitial && ' (Initial)'}
                      {state.isFinal && ' (Final)'}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {!lifecycleDefinitionId && availableLifecycles.length > 0 && (
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400">
                <AlertCircle className="w-4 h-4 inline mr-2" />
                No lifecycle assigned. Items will use legacy code-defined
                states.
              </div>
            )}

            {availableLifecycles.length === 0 && (
              <div className="p-3 bg-slate-100 border border-slate-300 rounded text-slate-600 text-sm dark:bg-slate-800 dark:border-slate-700 dark:text-slate-400">
                No lifecycles available.{' '}
                <Link
                  to="/lifecycles/new"
                  className="text-blue-600 hover:underline dark:text-blue-400"
                >
                  Create a lifecycle
                </Link>{' '}
                to assign it to this item type.
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Workflow Assignment by Change Type - ChangeOrder only */}
      {itemType === 'ChangeOrder' && (
        <Card>
          <CardHeader>
            <CardTitle>Default Workflows by Change Type</CardTitle>
            <CardDescription>
              Assign default approval workflows for each type of change order.
              When a change order is created, the corresponding workflow will be
              automatically started. All change types must have a workflow
              assigned.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {availableWorkflows.length === 0 ? (
              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded text-yellow-800 text-sm dark:bg-yellow-900/20 dark:border-yellow-800 dark:text-yellow-400">
                <AlertCircle className="w-4 h-4 inline mr-2" />
                No workflows available.{' '}
                <Link
                  to="/workflows/new"
                  className="text-yellow-900 underline dark:text-yellow-300"
                >
                  Create a workflow
                </Link>{' '}
                to assign it to change order types.
              </div>
            ) : (
              <>
                {CHANGE_ORDER_TYPES.map((changeType) => (
                  <div key={changeType} className="flex items-center gap-4">
                    <Label className="w-24 font-medium">{changeType}</Label>
                    <Select
                      value={workflowsByChangeType[changeType] || undefined}
                      onValueChange={(value) =>
                        setWorkflowsByChangeType((prev) => ({
                          ...prev,
                          [changeType]: value || undefined,
                        }))
                      }
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue placeholder="Select a workflow..." />
                      </SelectTrigger>
                      <SelectContent>
                        {availableWorkflows.map((workflow) => (
                          <SelectItem key={workflow.id} value={workflow.id}>
                            {workflow.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {workflowsByChangeType[changeType] && (
                      <Link
                        to="/workflows/$id"
                        params={{ id: workflowsByChangeType[changeType] }}
                      >
                        <Button variant="outline" size="sm">
                          <ExternalLink className="w-4 h-4" />
                        </Button>
                      </Link>
                    )}
                  </div>
                ))}
                {/* Warning if not all types are assigned */}
                {CHANGE_ORDER_TYPES.some(
                  (type) => !workflowsByChangeType[type],
                ) && (
                  <div className="p-3 bg-red-50 border border-red-200 rounded text-red-800 text-sm dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
                    <AlertCircle className="w-4 h-4 inline mr-2" />
                    All change types must have a workflow assigned. Change
                    orders cannot be created without a workflow.
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* Code Defaults Reference */}
      {codeConfig && (
        <Card className="opacity-70">
          <CardHeader>
            <CardTitle>Code Defaults (Read-Only Reference)</CardTitle>
            <CardDescription>
              Original configuration defined in code. Cannot be modified at
              runtime.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-slate-100 dark:bg-slate-800 p-4 rounded overflow-auto max-h-64">
              {JSON.stringify(codeConfig, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  )
}
