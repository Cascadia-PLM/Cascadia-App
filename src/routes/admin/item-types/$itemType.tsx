import { Link, createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  ExternalLink,
  RotateCcw,
  Save,
} from 'lucide-react'
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

export const Route = createFileRoute('/admin/item-types/$itemType')({
  component: ItemTypeConfigEditPage,
})

interface StateConfig {
  id: string
  name: string
  color?: string
  description?: string
  isInitial?: boolean
  isFinal?: boolean
}

interface PermissionConfig {
  create: Array<string>
  read: Array<string>
  update: Array<string>
  delete: Array<string>
}

interface RelationshipConfig {
  type: string
  label: string
  targetTypes: Array<string>
  allowMultiple: boolean
}

interface CodeConfig {
  label: string
  pluralLabel: string
  icon: string
  defaultState: string
  states: Array<StateConfig>
  lifecycleDefinitionId?: string
  permissions: PermissionConfig
  relationships: Array<RelationshipConfig>
  searchableFields: Array<string>
  displayField: string
}

interface LifecycleDefinition {
  id: string
  name: string
  definitionType: string
  states: Array<StateConfig>
  applicableItemTypes?: Array<string>
}

interface WorkflowsByChangeType {
  ECO?: string
  ECN?: string
  Deviation?: string
  MCO?: string
  XCO?: string
}

const CHANGE_ORDER_TYPES = ['ECO', 'ECN', 'Deviation', 'MCO', 'XCO'] as const

function ItemTypeConfigEditPage() {
  const { itemType } = Route.useParams()

  const [loading, setLoading] = useState(true)
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
  const [permissions, setPermissions] = useState<PermissionConfig>({
    create: [],
    read: [],
    update: [],
    delete: [],
  })
  const [workflowsByChangeType, setWorkflowsByChangeType] =
    useState<WorkflowsByChangeType>({})

  // Reference data
  const [hasRuntimeConfig, setHasRuntimeConfig] = useState(false)
  const [runtimeConfigVersion, setRuntimeConfigVersion] = useState(0)
  const [codeConfig, setCodeConfig] = useState<CodeConfig | null>(null)
  const [availableLifecycles, setAvailableLifecycles] = useState<
    Array<LifecycleDefinition>
  >([])
  const [availableWorkflows, setAvailableWorkflows] = useState<
    Array<LifecycleDefinition>
  >([])
  const [selectedLifecycle, setSelectedLifecycle] =
    useState<LifecycleDefinition | null>(null)

  useEffect(() => {
    fetchConfig()
    fetchLifecycles()
  }, [itemType])

  // Update selected lifecycle when lifecycleDefinitionId changes
  useEffect(() => {
    if (lifecycleDefinitionId && availableLifecycles.length > 0) {
      const lifecycle = availableLifecycles.find(
        (l) => l.id === lifecycleDefinitionId,
      )
      setSelectedLifecycle(lifecycle || null)
    } else {
      setSelectedLifecycle(null)
    }
  }, [lifecycleDefinitionId, availableLifecycles])

  const fetchLifecycles = async () => {
    try {
      const response = await fetch('/api/workflows')
      if (!response.ok) return

      const data = await response.json()
      const allDefinitions = data.data?.workflows || []
      // Filter to only show lifecycles (not workflows)
      const lifecycles = allDefinitions.filter(
        (w: LifecycleDefinition) => w.definitionType === 'lifecycle',
      )
      // Filter to only show workflows (not lifecycles)
      const workflows = allDefinitions.filter(
        (w: LifecycleDefinition) => w.definitionType === 'workflow',
      )
      setAvailableLifecycles(lifecycles)
      setAvailableWorkflows(workflows)
    } catch (err) {
      console.error('Failed to fetch lifecycles:', err)
    }
  }

  const fetchConfig = async () => {
    try {
      setError(null)
      const response = await fetch(`/api/admin/item-type-configs/${itemType}`)
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to fetch configuration')
      }

      const data = await response.json()
      const {
        codeConfig: code,
        runtimeConfig: runtime,
        mergedConfig: merged,
      } = data.data

      setCodeConfig(code)
      setHasRuntimeConfig(!!runtime)
      setRuntimeConfigVersion(runtime?.version || 0)

      // Load current values (from runtime if exists, otherwise from merged/code)
      const config = runtime?.config || merged || code
      setLabel(config.label || '')
      setPluralLabel(config.pluralLabel || '')
      setIcon(config.icon || '')
      setLifecycleDefinitionId(
        config.lifecycleDefinitionId || code.lifecycleDefinitionId || null,
      )
      setPermissions(
        config.permissions ||
          code.permissions || {
            create: [],
            read: [],
            update: [],
            delete: [],
          },
      )
      // Load workflowsByChangeType for ChangeOrder item type
      if (itemType === 'ChangeOrder') {
        setWorkflowsByChangeType(config.workflowsByChangeType || {})
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

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

      const response = await fetch('/api/admin/item-type-configs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemType, config }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to save configuration')
      }

      const data = await response.json()
      setHasRuntimeConfig(true)
      setRuntimeConfigVersion(data.data.config.version)
      setSuccessMessage('Configuration saved successfully!')
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
      const response = await fetch(`/api/admin/item-type-configs/${itemType}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to reset configuration')
      }

      await fetchConfig()
      setSuccessMessage('Configuration reset to code defaults!')
      setTimeout(() => setSuccessMessage(null), 5000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setSaving(false)
    }
  }

  const updatePermission = (action: keyof PermissionConfig, value: string) => {
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

  if (loading) {
    return (
      <PageContainer maxWidth="wide">
        <p className="text-slate-600 dark:text-slate-400">
          Loading configuration...
        </p>
      </PageContainer>
    )
  }

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
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded dark:bg-red-900/20 dark:border-red-800 dark:text-red-400">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            {error}
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
