import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, Loader2, Save } from 'lucide-react'
import type {
  LifecycleType,
  WorkflowDefinition,
  WorkflowType,
} from '@/lib/workflows/types'
import { LifecycleTypeSelector } from '@/components/workflows/LifecycleTypeSelector'
import { DriverSelector } from '@/components/workflows/DriverSelector'
import { WorkflowBuilder } from '@/components/workflows/WorkflowBuilder'
import {
  Badge,
  Button,
  Card,
  CardContent,
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
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/lifecycles/$id')({
  component: EditLifecyclePage,
})

function EditLifecyclePage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const { id } = Route.useParams()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [hasChanges, setHasChanges] = useState(false)
  const [loading, setLoading] = useState(true)
  const [definition, setDefinition] =
    useState<Partial<WorkflowDefinition> | null>(null)
  const [lifecycleType, setLifecycleType] = useState<LifecycleType>('Free')
  const [drivers, setDrivers] = useState<Array<string>>([])

  useEffect(() => {
    const loadLifecycle = async () => {
      try {
        const result = await apiFetch<{
          data: { workflow: WorkflowDefinition }
        }>(`/api/workflows/${id}`)
        setDefinition(result.data.workflow)

        // Determine lifecycle type
        const loadedType =
          result.data.workflow.lifecycleType ||
          (result.data.workflow.definitionType === 'lifecycle'
            ? 'Driven'
            : result.data.workflow.definitionType === 'workflow'
              ? 'Driving'
              : 'Free')
        setLifecycleType(loadedType)
        setDrivers(result.data.workflow.drivers || [])
      } catch (error) {
        handleError(error, { title: 'Failed to load lifecycle' })
      } finally {
        setLoading(false)
      }
    }
    loadLifecycle()
  }, [id, handleError])

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-600" />
        <span className="ml-2 text-slate-600 dark:text-slate-400">
          Loading lifecycle...
        </span>
      </div>
    )
  }

  if (!definition) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 flex items-center justify-center">
        <Card className="w-96">
          <CardContent className="pt-6">
            <div className="flex flex-col items-center gap-4 text-center">
              <AlertCircle className="h-12 w-12 text-red-500" />
              <h2 className="text-xl font-semibold">Lifecycle Not Found</h2>
              <p className="text-slate-600 dark:text-slate-400">
                The lifecycle you&apos;re looking for doesn&apos;t exist or has
                been deleted.
              </p>
              <Button onClick={() => navigate({ to: '/lifecycles' })}>
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Lifecycles
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    )
  }

  const handleChange = (updates: Partial<WorkflowDefinition>) => {
    setDefinition(updates)
    setHasChanges(true)
  }

  const handleLifecycleTypeChange = (newType: LifecycleType) => {
    setLifecycleType(newType)
    setHasChanges(true)
  }

  const handleDriversChange = (newDrivers: Array<string>) => {
    setDrivers(newDrivers)
    setHasChanges(true)
  }

  const handleSave = async () => {
    if (!definition.name?.trim()) {
      handleError(new Error('Please enter a name for the lifecycle'), {
        title: 'Validation Error',
      })
      return
    }

    setIsSubmitting(true)
    try {
      // Determine definitionType based on lifecycleType for backward compatibility
      const definitionType =
        lifecycleType === 'Driving' ? 'workflow' : 'lifecycle'

      await apiFetch(`/api/workflows/${definition.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...definition,
          definitionType,
          lifecycleType,
          drivers: lifecycleType === 'Driven' ? drivers : [],
          // For Driven lifecycles, clear transitions (states only)
          transitions: lifecycleType === 'Driven' ? [] : definition.transitions,
        }),
      })

      setHasChanges(false)
      showSuccess('Lifecycle saved', 'Lifecycle has been saved successfully')
    } catch (error) {
      handleError(error, { title: 'Failed to update lifecycle' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const getLifecycleTypeBadge = () => {
    switch (lifecycleType) {
      case 'Driving':
        return (
          <Badge variant="outline" className="bg-cyan-50 dark:bg-cyan-950">
            Driving
          </Badge>
        )
      case 'Driven':
        return (
          <Badge variant="outline" className="bg-amber-50 dark:bg-amber-950">
            Driven
          </Badge>
        )
      default:
        return <Badge variant="outline">Free</Badge>
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900">
      <div className="h-screen flex flex-col">
        {/* Header */}
        <div className="border-b bg-white dark:bg-slate-950 px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => navigate({ to: '/lifecycles' })}
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                    {definition.name}
                  </h1>
                  {getLifecycleTypeBadge()}
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {definition.states?.length || 0} states,{' '}
                  {definition.transitions?.length || 0} transitions
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {hasChanges && (
                <span className="text-sm text-amber-600 dark:text-amber-400">
                  Unsaved changes
                </span>
              )}
              <Button
                onClick={handleSave}
                disabled={isSubmitting || !hasChanges}
              >
                <Save className="h-4 w-4 mr-2" />
                {isSubmitting ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 flex overflow-hidden">
          {/* Left Panel - Settings */}
          <div className="w-96 border-r bg-white dark:bg-slate-950 overflow-y-auto p-4 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Lifecycle Type</CardTitle>
              </CardHeader>
              <CardContent>
                <LifecycleTypeSelector
                  value={lifecycleType}
                  onChange={handleLifecycleTypeChange}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Basic Information</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="name" className="text-xs">
                    Name *
                  </Label>
                  <Input
                    id="name"
                    value={definition.name}
                    onChange={(e) =>
                      handleChange({ ...definition, name: e.target.value })
                    }
                    placeholder="e.g., Part Lifecycle, ECO Workflow"
                    className="h-8 text-sm"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Mode</Label>
                  <Select
                    value={definition.workflowType}
                    onValueChange={(value: WorkflowType) =>
                      handleChange({ ...definition, workflowType: value })
                    }
                  >
                    <SelectTrigger className="h-8 text-sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="strict">Strict</SelectItem>
                      <SelectItem value="flexible">Flexible</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="description" className="text-xs">
                    Description
                  </Label>
                  <textarea
                    id="description"
                    value={definition.description || ''}
                    onChange={(e) =>
                      handleChange({
                        ...definition,
                        description: e.target.value,
                      })
                    }
                    className="w-full h-20 px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 resize-none"
                    placeholder="What types of items use this lifecycle?"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="isActive"
                    checked={definition.isActive ?? true}
                    onChange={(e) =>
                      handleChange({
                        ...definition,
                        isActive: e.target.checked,
                      })
                    }
                    className="rounded"
                  />
                  <Label htmlFor="isActive" className="text-sm">
                    Active
                  </Label>
                </div>
              </CardContent>
            </Card>

            {/* Driver Selector for Driven lifecycles */}
            {lifecycleType === 'Driven' && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm">ECO Drivers</CardTitle>
                </CardHeader>
                <CardContent>
                  <DriverSelector
                    selectedDriverIds={drivers}
                    onChange={handleDriversChange}
                  />
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">Statistics</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-600 dark:text-slate-400">
                    States
                  </span>
                  <span className="font-medium">
                    {definition.states?.length || 0}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600 dark:text-slate-400">
                    Transitions
                  </span>
                  <span className="font-medium">
                    {definition.transitions?.length || 0}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600 dark:text-slate-400">
                    Initial State
                  </span>
                  <span className="font-medium">
                    {definition.states?.find((s) => s.isInitial)?.name ||
                      'None'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-600 dark:text-slate-400">
                    Final States
                  </span>
                  <span className="font-medium">
                    {definition.states?.filter((s) => s.isFinal).length || 0}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Right Panel - Workflow Builder */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {lifecycleType !== 'Driving' && (
              <div className="p-4 border-b bg-white dark:bg-slate-950">
                <h2 className="text-lg font-semibold">States</h2>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {lifecycleType === 'Driven'
                    ? 'Define the valid states for this lifecycle. ECOs will transition items between these states.'
                    : 'Define the valid states for this lifecycle. Users can freely transition items between states.'}
                </p>
              </div>
            )}
            <div className="flex-1">
              <WorkflowBuilder
                definition={definition}
                definitionType={
                  lifecycleType === 'Driving' ? 'workflow' : 'lifecycle'
                }
                lifecycleType={lifecycleType}
                onChange={handleChange}
                disableTransitions={lifecycleType !== 'Driving'}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
