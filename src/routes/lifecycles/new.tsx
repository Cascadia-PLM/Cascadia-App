import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft, Save } from 'lucide-react'
import type {
  LifecycleType,
  WorkflowDefinition,
  WorkflowType,
} from '@/lib/workflows/types'
import { LifecycleTypeSelector } from '@/components/workflows/LifecycleTypeSelector'
import { DriverSelector } from '@/components/workflows/DriverSelector'
import { WorkflowBuilder } from '@/components/workflows/WorkflowBuilder'
import {
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

export const Route = createFileRoute('/lifecycles/new')({
  component: NewLifecyclePage,
})

function NewLifecyclePage() {
  const navigate = useNavigate()
  const { handleError, showSuccess } = useErrorHandler()
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [lifecycleType, setLifecycleType] = useState<LifecycleType>('Free')
  const [drivers, setDrivers] = useState<Array<string>>([])

  const [definition, setDefinition] = useState<Partial<WorkflowDefinition>>({
    name: '',
    definitionType: 'lifecycle',
    workflowType: 'strict',
    description: '',
    states: [
      {
        id: 'Draft',
        name: 'Draft',
        color: 'gray',
        isInitial: true,
        isFinal: false,
        description: 'Item is being created or edited',
      },
      {
        id: 'Released',
        name: 'Released',
        color: 'green',
        isInitial: false,
        isFinal: false,
        description: 'Item is released for use',
      },
      {
        id: 'Obsolete',
        name: 'Obsolete',
        color: 'red',
        isInitial: false,
        isFinal: true,
        description: 'Item is no longer used',
      },
    ],
    transitions: [],
    isActive: true,
  })

  const handleChange = (updates: Partial<WorkflowDefinition>) => {
    setDefinition(updates)
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

      const result = await apiFetch<{ data: { workflow: WorkflowDefinition } }>(
        '/api/v1/workflows',
        {
          method: 'POST',
          body: JSON.stringify({
            ...definition,
            definitionType,
            lifecycleType,
            drivers: lifecycleType === 'Driven' ? drivers : [],
            // For Driven lifecycles, clear transitions (states only)
            transitions:
              lifecycleType === 'Driven' ? [] : definition.transitions,
          }),
        },
      )

      showSuccess(
        'Lifecycle created',
        'Lifecycle has been created successfully',
      )
      navigate({
        to: '/lifecycles/$id',
        params: { id: result.data.workflow.id },
      })
    } catch (error) {
      handleError(error, { title: 'Failed to create lifecycle' })
    } finally {
      setIsSubmitting(false)
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
                <h1 className="text-2xl font-bold text-slate-900 dark:text-white">
                  Create New Lifecycle
                </h1>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Define states and transitions for item lifecycle management
                </p>
              </div>
            </div>
            <Button onClick={handleSave} disabled={isSubmitting}>
              <Save className="h-4 w-4 mr-2" />
              {isSubmitting ? 'Saving...' : 'Save Lifecycle'}
            </Button>
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
                  onChange={setLifecycleType}
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
                      setDefinition((prev) => ({
                        ...prev,
                        name: e.target.value,
                      }))
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
                      setDefinition((prev) => ({
                        ...prev,
                        workflowType: value,
                      }))
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
                      setDefinition((prev) => ({
                        ...prev,
                        description: e.target.value,
                      }))
                    }
                    className="w-full h-20 px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 resize-none"
                    placeholder="What types of items will use this lifecycle?"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    id="isActive"
                    checked={definition.isActive ?? true}
                    onChange={(e) =>
                      setDefinition((prev) => ({
                        ...prev,
                        isActive: e.target.checked,
                      }))
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
                    onChange={setDrivers}
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

            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm">About Lifecycle Types</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-slate-600 dark:text-slate-400 space-y-2">
                {lifecycleType === 'Free' && (
                  <>
                    <p>
                      <strong>Free:</strong> Self-controlled lifecycles where
                      users manually transition items between states.
                    </p>
                    <p>Use for: Programs, Projects, Designs</p>
                  </>
                )}
                {lifecycleType === 'Driven' && (
                  <>
                    <p>
                      <strong>Driven:</strong> ECO-controlled lifecycles that
                      define valid states. Items transition only through ECOs.
                    </p>
                    <p>Use for: Parts, Documents, Requirements</p>
                    <p>
                      <strong>Note:</strong> Define states only - transitions
                      are handled by the Driving lifecycle (ECO workflow).
                    </p>
                  </>
                )}
                {lifecycleType === 'Driving' && (
                  <>
                    <p>
                      <strong>Driving:</strong> ECO workflow that controls
                      Driven lifecycles. Can include Transition Driven Item
                      actions.
                    </p>
                    <p>Use for: Change Orders (ECO, XCO, MCO)</p>
                  </>
                )}
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
