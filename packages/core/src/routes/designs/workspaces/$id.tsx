// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ArrowLeft, FileBox, GitBranch, GitMerge, Trash2 } from 'lucide-react'
import { z } from 'zod'
import { PageContainer } from '@/components/layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  useInvalidateResources,
  workspaceCommitsQuery,
  workspaceDetailQuery,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { ConvertToEcoDialog } from '@/components/workspaces/ConvertToEcoDialog'
import { MergeToEcoDialog } from '@/components/workspaces/MergeToEcoDialog'
import { WorkspaceItemsPanel } from '@/components/workspaces/WorkspaceItemsPanel'

/** The tabs the workspace page renders; the search schema derives from this list. */
const WORKSPACE_DETAIL_TABS = ['overview', 'items', 'commits'] as const
type WorkspaceDetailTab = (typeof WORKSPACE_DETAIL_TABS)[number]

// Search schema for tab state
const workspaceDetailSearchSchema = z.object({
  tab: z.enum(WORKSPACE_DETAIL_TABS).optional().default('overview'),
})

export const Route = createFileRoute('/designs/workspaces/$id')({
  component: WorkspaceDetailPage,
  validateSearch: workspaceDetailSearchSchema,
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(workspaceDetailQuery(params.id)),
      queryClient.ensureQueryData(workspaceCommitsQuery(params.id)),
    ])
  },
})

function WorkspaceDetailPage() {
  const { id } = Route.useParams()
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const [convertToEcoDialogOpen, setConvertToEcoDialogOpen] = useState(false)
  const [mergeToEcoDialogOpen, setMergeToEcoDialogOpen] = useState(false)

  const { data: workspace } = useQuery(workspaceDetailQuery(id))
  const { data: commits = [], isLoading: loadingCommits } = useQuery(
    workspaceCommitsQuery(id),
  )

  // Tab state from URL
  const search = Route.useSearch()
  const activeTab = search.tab

  const handleTabChange = (tab: WorkspaceDetailTab) => {
    router.navigate({
      to: '/designs/workspaces/$id',
      params: { id },
      search: { tab },
      replace: true,
    })
  }

  if (!workspace) return null

  const displayName = workspace.name.replace('workspace/', '')

  const handleDelete = () => {
    // Only items created on the workspace die with it — checkouts revert
    const draftCount = workspace.workspaceOnlyItemCount

    let description = `Are you sure you want to delete the workspace "${displayName}"?`
    if (draftCount > 0) {
      description += `\n\nThis will permanently delete ${draftCount} item${draftCount === 1 ? '' : 's'} that exist${draftCount === 1 ? 's' : ''} only on this workspace.`
    }
    description += '\n\nThis action cannot be undone.'

    confirm({
      title: 'Delete Workspace',
      description,
      actionLabel:
        draftCount > 0
          ? `Delete Workspace and ${draftCount} Item${draftCount === 1 ? '' : 's'}`
          : 'Delete Workspace',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/workspaces/${id}`, {
            method: 'DELETE',
          })

          showSuccess('Workspace deleted', `"${displayName}" has been deleted`)
          await invalidate('workspaces')
          router.navigate({ to: '/designs/workspaces' })
        } catch (error) {
          handleError(error, { title: 'Failed to delete workspace' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/designs/workspaces">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <GitBranch className="h-8 w-8 text-cyan-500" />
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {displayName}
              </h1>
              <Badge variant="secondary" className="text-base">
                Workspace
              </Badge>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {workspace.designName}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Button
            variant="default"
            onClick={() => setConvertToEcoDialogOpen(true)}
            disabled={workspace.itemCount === 0}
          >
            <FileBox className="h-4 w-4 mr-2" />
            Convert to ECO
          </Button>
          <Button
            variant="outline"
            onClick={() => setMergeToEcoDialogOpen(true)}
            disabled={workspace.itemCount === 0}
          >
            <GitMerge className="h-4 w-4 mr-2" />
            Merge to ECO
          </Button>
          <Button variant="destructive" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 mr-2" />
            Delete
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => handleTabChange(value as WorkspaceDetailTab)}
        className="w-full"
      >
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="items">Items</TabsTrigger>
          <TabsTrigger value="commits">Commits ({commits.length})</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="mt-6 space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Workspace Summary</CardTitle>
              <CardDescription>
                Overview of your workspace changes
              </CardDescription>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    Workspace Name
                  </dt>
                  <dd className="mt-1 text-lg font-semibold text-slate-900 dark:text-white">
                    {displayName}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    Design
                  </dt>
                  <dd className="mt-1">
                    <Link
                      to="/designs/$id"
                      params={{ id: workspace.designId }}
                      className="text-lg text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {workspace.designCode || workspace.designName}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    Items
                  </dt>
                  <dd className="mt-1 text-lg text-slate-900 dark:text-white">
                    {workspace.itemCount} item
                    {workspace.itemCount !== 1 ? 's' : ''}
                  </dd>
                </div>
                <div>
                  <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    Created
                  </dt>
                  <dd className="mt-1 text-lg text-slate-900 dark:text-white">
                    {new Date(workspace.createdAt).toLocaleDateString()}
                  </dd>
                </div>
              </dl>
            </CardContent>
          </Card>

          {/* Actions Card */}
          <Card>
            <CardHeader>
              <CardTitle>Workspace Actions</CardTitle>
              <CardDescription>Convert or merge this workspace</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="p-4 border border-slate-300 dark:border-slate-700 rounded-lg">
                <div className="flex items-start gap-3">
                  <FileBox className="h-5 w-5 text-blue-600 dark:text-blue-400 mt-1" />
                  <div className="flex-1">
                    <h3 className="font-medium text-slate-900 dark:text-white mb-1">
                      Convert to ECO
                    </h3>
                    <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                      Create a new Engineering Change Order from all items in
                      this workspace. This will move all changes to a formal
                      change control process.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => setConvertToEcoDialogOpen(true)}
                      disabled={workspace.itemCount === 0}
                    >
                      <FileBox className="h-4 w-4 mr-2" />
                      Convert to ECO
                    </Button>
                  </div>
                </div>
              </div>

              <div className="p-4 border border-slate-300 dark:border-slate-700 rounded-lg">
                <div className="flex items-start gap-3">
                  <GitMerge className="h-5 w-5 text-purple-600 dark:text-purple-400 mt-1" />
                  <div className="flex-1">
                    <h3 className="font-medium text-slate-900 dark:text-white mb-1">
                      Merge to Existing ECO
                    </h3>
                    <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
                      Add all items from this workspace to an existing ECO. This
                      combines your workspace changes with other changes already
                      in the ECO.
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setMergeToEcoDialogOpen(true)}
                      disabled={workspace.itemCount === 0}
                    >
                      <GitMerge className="h-4 w-4 mr-2" />
                      Merge to ECO
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Items Tab */}
        <TabsContent value="items" className="mt-6">
          <WorkspaceItemsPanel workspaceId={workspace.id} />
        </TabsContent>

        {/* Commits Tab */}
        <TabsContent value="commits" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Commit History</CardTitle>
              <CardDescription>
                All commits made on this workspace branch
              </CardDescription>
            </CardHeader>
            <CardContent>
              {loadingCommits ? (
                <div className="text-center py-8 text-slate-500">
                  Loading commits...
                </div>
              ) : commits.length === 0 ? (
                <div className="text-center py-8 border rounded-lg">
                  <GitBranch className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
                  <p className="text-slate-500 dark:text-slate-400">
                    No commits yet
                  </p>
                  <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
                    Commits will appear here as you save changes to items
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {commits.map((commit) => (
                    <div
                      key={commit.id}
                      className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-300 dark:border-slate-700"
                    >
                      <div className="font-medium text-slate-900 dark:text-white">
                        {commit.message || '(No message)'}
                      </div>
                      <div className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                        {commit.createdAt instanceof Date
                          ? commit.createdAt.toLocaleString()
                          : new Date(commit.createdAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <ConvertToEcoDialog
        open={convertToEcoDialogOpen}
        onOpenChange={setConvertToEcoDialogOpen}
        workspaceId={workspace.id}
        workspaceName={displayName}
        itemCount={workspace.itemCount}
        onSuccess={(ecoId, ecoNumber) => {
          showSuccess('ECO created', `Successfully created ${ecoNumber}`)
          void invalidate('workspaces', 'change-orders')
          router.navigate({ to: '/change-orders/$id', params: { id: ecoId } })
        }}
      />

      <MergeToEcoDialog
        open={mergeToEcoDialogOpen}
        onOpenChange={setMergeToEcoDialogOpen}
        workspaceId={workspace.id}
        workspaceName={displayName}
        designId={workspace.designId}
        itemCount={workspace.itemCount}
        onSuccess={(ecoId) => {
          showSuccess('Workspace merged', 'Items added to ECO')
          void invalidate('workspaces', 'change-orders')
          router.navigate({ to: '/change-orders/$id', params: { id: ecoId } })
        }}
      />
    </PageContainer>
  )
}
