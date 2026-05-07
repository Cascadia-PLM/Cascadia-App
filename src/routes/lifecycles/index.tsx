import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { GitBranch, Loader2, Plus, RotateCcw, Workflow } from 'lucide-react'
import type { LifecycleType, WorkflowDefinition } from '@/lib/workflows/types'
import { PageContainer } from '@/components/layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { LifecycleTable } from '@/components/lifecycles/LifecycleTable'

export const Route = createFileRoute('/lifecycles/')({
  component: LifecyclesListPage,
})

function LifecyclesListPage() {
  const router = useRouter()
  const { confirm, alert } = useAlertDialog()
  const [lifecycles, setLifecycles] = useState<Array<WorkflowDefinition>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const loadLifecycles = async () => {
      try {
        // Load all workflows (both lifecycles and workflows - now unified)
        const response = await fetch('/api/workflows')
        if (response.ok) {
          const { data } = await response.json()
          setLifecycles(data?.workflows || [])
        }
      } catch (error) {
        console.error('Error loading lifecycles:', error)
      } finally {
        setLoading(false)
      }
    }
    loadLifecycles()
  }, [])

  // Helper to get lifecycle type with fallback for legacy data
  const getLifecycleType = (lifecycle: WorkflowDefinition): LifecycleType => {
    if (lifecycle.lifecycleType) return lifecycle.lifecycleType
    if (lifecycle.definitionType === 'lifecycle') return 'Driven'
    return 'Driving'
  }

  // Group lifecycles by type
  const freeLifecycles = lifecycles.filter(
    (l) => getLifecycleType(l) === 'Free',
  )
  const drivenLifecycles = lifecycles.filter(
    (l) => getLifecycleType(l) === 'Driven',
  )
  const drivingLifecycles = lifecycles.filter(
    (l) => getLifecycleType(l) === 'Driving',
  )

  const handleDelete = (lifecycle: WorkflowDefinition) => {
    confirm({
      title: 'Delete Lifecycle',
      description: `Are you sure you want to delete "${lifecycle.name}"? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          const response = await fetch(`/api/workflows/${lifecycle.id}`, {
            method: 'DELETE',
          })

          if (!response.ok) {
            const error = await response.json()
            throw new Error(error.details || 'Failed to delete lifecycle')
          }

          setLifecycles(lifecycles.filter((l) => l.id !== lifecycle.id))
          router.invalidate()
        } catch (error) {
          console.error('Error deleting lifecycle:', error)
          alert({
            title: 'Error',
            description: `Failed to delete lifecycle: ${(error as Error).message}`,
            variant: 'destructive',
          })
        }
      },
    })
  }

  if (loading) {
    return (
      <PageContainer>
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-8 w-8 animate-spin text-cyan-600" />
          <span className="ml-2 text-slate-600 dark:text-slate-400">
            Loading lifecycles...
          </span>
        </div>
      </PageContainer>
    )
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Lifecycles
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Unified lifecycle management for all item types
          </p>
        </div>
        <Link to="/lifecycles/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Lifecycle
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total</CardDescription>
            <CardTitle className="text-3xl">{lifecycles.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>
              <div className="flex items-center gap-1">
                <Badge variant="outline" className="text-xs">
                  Free
                </Badge>
              </div>
            </CardDescription>
            <CardTitle className="text-3xl">{freeLifecycles.length}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>
              <div className="flex items-center gap-1">
                <Badge
                  variant="outline"
                  className="text-xs bg-amber-50 dark:bg-amber-950"
                >
                  Driven
                </Badge>
              </div>
            </CardDescription>
            <CardTitle className="text-3xl">
              {drivenLifecycles.length}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>
              <div className="flex items-center gap-1">
                <Badge
                  variant="outline"
                  className="text-xs bg-cyan-50 dark:bg-cyan-950"
                >
                  Driving
                </Badge>
              </div>
            </CardDescription>
            <CardTitle className="text-3xl">
              {drivingLifecycles.length}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Driving Lifecycles (ECO Workflows) */}
      {drivingLifecycles.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Workflow className="h-5 w-5 text-cyan-600" />
              <CardTitle>Driving Lifecycles</CardTitle>
              <Badge variant="outline" className="bg-cyan-50 dark:bg-cyan-950">
                ECO Workflows
              </Badge>
            </div>
            <CardDescription>
              Change order workflows that control Driven lifecycles. These
              include approval flows and TransitionDrivenItem actions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LifecycleTable
              lifecycles={drivingLifecycles}
              onDelete={handleDelete}
            />
          </CardContent>
        </Card>
      )}

      {/* Driven Lifecycles (Parts, Documents) */}
      {drivenLifecycles.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-amber-600" />
              <CardTitle>Driven Lifecycles</CardTitle>
              <Badge
                variant="outline"
                className="bg-amber-50 dark:bg-amber-950"
              >
                ECO-Controlled
              </Badge>
            </div>
            <CardDescription>
              Lifecycles for Parts, Documents, and Requirements. Items can only
              transition through ECO actions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LifecycleTable
              lifecycles={drivenLifecycles}
              onDelete={handleDelete}
            />
          </CardContent>
        </Card>
      )}

      {/* Free Lifecycles (Programs, Projects) */}
      {freeLifecycles.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-slate-600" />
              <CardTitle>Free Lifecycles</CardTitle>
              <Badge variant="outline">Self-Controlled</Badge>
            </div>
            <CardDescription>
              Self-controlled lifecycles for Programs, Projects, and Designs.
              Users can manually transition items between states.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LifecycleTable
              lifecycles={freeLifecycles}
              onDelete={handleDelete}
            />
          </CardContent>
        </Card>
      )}

      {/* Show all if no grouped data */}
      {lifecycles.length === 0 && (
        <Card>
          <CardHeader>
            <CardTitle>No Lifecycles</CardTitle>
            <CardDescription>
              Create your first lifecycle to get started.
            </CardDescription>
          </CardHeader>
        </Card>
      )}
    </PageContainer>
  )
}
