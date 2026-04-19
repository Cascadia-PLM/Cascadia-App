import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft, GitBranch, Trash2 } from 'lucide-react'
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
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

interface Workspace {
  id: string
  name: string
  designId: string
  designName: string
  createdAt: Date
  isLocked: boolean | null
  isArchived: boolean | null
  ownerId: string | null
}

export const Route = createFileRoute('/designs/workspaces/')({
  component: WorkspacesPage,
  loader: async () => {
    const result = await apiFetch<{ data: { workspaces: Array<Workspace> } }>(
      '/api/workspaces',
    )
    return { workspaces: result.data.workspaces }
  },
})

function WorkspacesPage() {
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { workspaces: initialWorkspaces } = Route.useLoaderData()
  const [workspaces, setWorkspaces] =
    useState<Array<Workspace>>(initialWorkspaces)

  const handleDeleteWorkspace = async (workspace: Workspace) => {
    const displayName = workspace.name.replace('workspace/', '')

    // Fetch item count to show in confirmation
    let itemCount = 0
    try {
      const response = await apiFetch<{ data: { itemCount: number } }>(
        `/api/workspaces/${workspace.id}`,
      )
      itemCount = response.data.itemCount
    } catch {
      // If we can't fetch, proceed without count
    }

    // Build description with item count warning
    let description = `Are you sure you want to delete the workspace "${displayName}" from ${workspace.designName}?`
    if (itemCount > 0) {
      description += `\n\nThis will permanently delete ${itemCount} item${itemCount === 1 ? '' : 's'} that exist${itemCount === 1 ? 's' : ''} only on this workspace.`
    }
    description += '\n\nThis action cannot be undone.'

    confirm({
      title: 'Delete Workspace',
      description,
      actionLabel:
        itemCount > 0
          ? `Delete Workspace and ${itemCount} Item${itemCount === 1 ? '' : 's'}`
          : 'Delete Workspace',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/workspaces/${workspace.id}`, {
            method: 'DELETE',
          })

          setWorkspaces(workspaces.filter((w) => w.id !== workspace.id))
          showSuccess('Workspace deleted', `"${displayName}" has been deleted`)
          router.invalidate()
        } catch (error) {
          handleError(error, { title: 'Failed to delete workspace' })
        }
      },
    })
  }

  // Group workspaces by design
  const workspacesByDesign = workspaces.reduce<
    Record<string, { designName: string; workspaces: Array<Workspace> }>
  >((acc, ws) => {
    if (!(ws.designId in acc)) {
      acc[ws.designId] = {
        designName: ws.designName,
        workspaces: [],
      }
    }
    acc[ws.designId].workspaces.push(ws)
    return acc
  }, {})

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link to="/designs">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            My Workspaces
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-1">
            Manage your private development branches
          </p>
        </div>
      </div>

      {/* Stats */}
      <Card>
        <CardHeader className="pb-3">
          <CardDescription>Total Workspaces</CardDescription>
          <CardTitle className="text-3xl">{workspaces.length}</CardTitle>
        </CardHeader>
      </Card>

      {/* Workspaces by Design */}
      {Object.keys(workspacesByDesign).length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <GitBranch className="h-12 w-12 text-slate-300 dark:text-slate-600 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-slate-900 dark:text-white mb-2">
              No workspaces yet
            </h3>
            <p className="text-slate-600 dark:text-slate-400 max-w-md mx-auto">
              Workspaces are private branches for development work. Create one
              when adding new items to a design.
            </p>
          </CardContent>
        </Card>
      ) : (
        Object.entries(workspacesByDesign).map(
          ([designId, { designName, workspaces: designWorkspaces }]) => (
            <Card key={designId}>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link
                    to="/designs/$id"
                    params={{ id: designId }}
                    className="hover:underline"
                  >
                    {designName}
                  </Link>
                </CardTitle>
                <CardDescription>
                  {designWorkspaces.length} workspace
                  {designWorkspaces.length !== 1 ? 's' : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {designWorkspaces.map((workspace) => {
                    const displayName = workspace.name.replace('workspace/', '')
                    return (
                      <div
                        key={workspace.id}
                        className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
                      >
                        <Link
                          to="/designs/workspaces/$id"
                          params={{ id: workspace.id }}
                          className="flex items-center gap-3 flex-1"
                        >
                          <GitBranch className="h-5 w-5 text-cyan-500" />
                          <div>
                            <div className="font-medium text-slate-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400">
                              {displayName}
                            </div>
                            <div className="text-sm text-slate-500">
                              Created{' '}
                              {workspace.createdAt instanceof Date
                                ? workspace.createdAt.toLocaleDateString()
                                : new Date(
                                    workspace.createdAt,
                                  ).toLocaleDateString()}
                            </div>
                          </div>
                          {workspace.isLocked && (
                            <Badge variant="secondary">Locked</Badge>
                          )}
                        </Link>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDeleteWorkspace(workspace)}
                          className="text-slate-500 hover:text-red-600"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </CardContent>
            </Card>
          ),
        )
      )}
    </PageContainer>
  )
}
