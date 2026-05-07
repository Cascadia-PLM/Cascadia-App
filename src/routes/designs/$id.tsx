import { useRef, useState } from 'react'
import { createFileRoute, useNavigate, useRouter } from '@tanstack/react-router'
import { z } from 'zod'
import type { Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type { DesignDetailsSectionHandle } from '@/components/designs/DesignDetailsSection'
import { DesignPageHeader } from '@/components/designs/DesignPageHeader'
import { DesignDetailsSection } from '@/components/designs/DesignDetailsSection'
import { CloneDesignDialog } from '@/components/designs/CloneDesignDialog'
import { CreateMbomDialog } from '@/components/mbom/CreateMbomDialog'
import { GapAnalysisDialog } from '@/components/gaps/GapAnalysisDialog'
import { UpstreamChangesBanner } from '@/components/mbom/UpstreamChangesBanner'
import { HistoricalViewBanner } from '@/components/designs/HistoricalViewBanner'
import { InitialReleaseHelper } from '@/components/versioning/InitialReleaseHelper'
import { StructureTab } from '@/components/designs/StructureTab'
import { LibraryItemsTab } from '@/components/designs/LibraryItemsTab'
import { HistoryTab } from '@/components/designs/HistoryTab'
import { ECOsTab } from '@/components/designs/ECOsTab'
import { BaselinesTab } from '@/components/designs/BaselinesTab'
import { MembersTab } from '@/components/designs/MembersTab'
import { PageContainer } from '@/components/layout'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import { apiFetch } from '@/lib/api/client'

interface Branch {
  id: string
  name: string
  branchType: string
  isArchived: boolean
  isLocked: boolean
  createdAt: string
}

interface TagItem {
  id: string
  name: string
  tagType: string
  description?: string
  createdAt: string
}

interface DesignWithDetails extends Design {
  defaultBranch?: Branch | null
  program?: Program | null
  parentDesign?: { id: string; code: string; name: string } | null
}

// Search schema for URL validation
const designSearchSchema = z.object({
  tab: z
    .enum(['structure', 'items', 'history', 'ecos', 'baselines', 'members'])
    .optional(),
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
  // DataGrid URL state (used by useServerDataGrid on Items tab)
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  search: z.coerce.string().optional(),
  filter_itemType: z.coerce.string().optional(),
  filter_state: z.coerce.string().optional(),
  filter_name: z.coerce.string().optional(),
  filter_itemNumber: z.coerce.string().optional(),
})

export const Route = createFileRoute('/designs/$id')({
  validateSearch: designSearchSchema,
  component: DesignDetailPage,
  loader: async ({ params }) => {
    try {
      const [designResult, branchesResult, tagsResult, programsResult] =
        await Promise.all([
          apiFetch<{ data: { design: DesignWithDetails } }>(
            `/api/v1/designs/${params.id}`,
          ),
          apiFetch<{ data: { branches: Array<Branch> } }>(
            `/api/v1/designs/${params.id}/branches?includeArchived=true`,
          ).catch(() => ({ data: { branches: [] as Array<Branch> } })),
          apiFetch<{ data: { tags: Array<TagItem> } }>(
            `/api/v1/designs/${params.id}/tags`,
          ).catch(() => ({ data: { tags: [] as Array<TagItem> } })),
          apiFetch<{ data: { programs: Array<Program> } }>(
            '/api/v1/programs',
          ).catch(() => ({ data: { programs: [] as Array<Program> } })),
        ])

      return {
        design: designResult.data.design,
        branches: branchesResult.data.branches,
        tags: tagsResult.data.tags,
        programs: programsResult.data.programs,
      }
    } catch (error) {
      console.error('Error loading design:', error)
      throw error
    }
  },
})

function DesignDetailPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { design, branches, tags, programs } = Route.useLoaderData()
  const searchParams = Route.useSearch()
  const detailsRef = useRef<DesignDetailsSectionHandle>(null)
  const [isEditingDetails, setIsEditingDetails] = useState(false)
  const [isSavingDetails, setIsSavingDetails] = useState(false)
  const [isCloneDialogOpen, setIsCloneDialogOpen] = useState(false)
  const [isMbomDialogOpen, setIsMbomDialogOpen] = useState(false)
  const [isGapAnalysisOpen, setIsGapAnalysisOpen] = useState(false)

  // Check if this is an Engineering design that can be released to manufacturing
  const canReleaseToManufacturing = design.designType === 'Engineering'

  // Check if this is a Manufacturing design that should show upstream changes
  const isManufacturingDesign = design.designType === 'Manufacturing'

  // Version context from URL
  const { context, isHistoricalView, setContext, setMainContext } =
    useVersionContext(design.id)

  // Determine if this is a family or library design
  const isFamily = design.designType === 'Family'
  const isLibrary = design.designType === 'Library'

  // Active tab from URL (default varies by design type)
  const activeTab =
    searchParams.tab ||
    (isFamily ? 'members' : isLibrary ? 'items' : 'structure')

  // Handle tab change
  const handleTabChange = (tab: string) => {
    navigate({
      to: '/designs/$id',
      params: { id: design.id },
      search: (prev) => ({
        ...prev,
        tab: tab as
          | 'structure'
          | 'items'
          | 'history'
          | 'ecos'
          | 'baselines'
          | 'members',
      }),
    })
  }

  // Handle version context change
  const handleContextChange = (newContext: VersionContext) => {
    setContext(newContext)
  }

  // Handle view baseline (from baselines tab or history tab)
  const handleViewBaseline = (tagId: string, tagName: string) => {
    setContext({ type: 'tag', tagId, tagName })
  }

  // Handle return to current
  const handleReturnToCurrent = () => {
    setMainContext()
  }

  // Toggle edit mode for details section
  const handleEdit = () => {
    setIsEditingDetails(true)
  }

  const handleCancelEdit = () => {
    setIsEditingDetails(false)
  }

  const handleSaveDetails = async () => {
    setIsSavingDetails(true)
    try {
      await detailsRef.current?.save()
    } catch {
      // Error already handled inside save()
    } finally {
      setIsSavingDetails(false)
    }
  }

  // Refresh data after update
  const handleDetailsUpdate = () => {
    router.invalidate()
  }

  const handleArchive = () => {
    confirm({
      title: 'Archive Design',
      description: `Are you sure you want to archive ${design.code}? The design will no longer appear in lists but data will be preserved.`,
      actionLabel: 'Archive',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/designs/${design.id}`, {
            method: 'DELETE',
          })

          showSuccess('Design archived', `${design.code} has been archived`)
          router.navigate({ to: '/designs' })
        } catch (error) {
          handleError(error, { title: 'Failed to archive design' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <DesignPageHeader
        design={design}
        branches={branches}
        tags={tags}
        versionContext={context}
        onContextChange={handleContextChange}
        isHistoricalView={isHistoricalView}
        isEditing={isEditingDetails}
        isSaving={isSavingDetails}
        onEdit={handleEdit}
        onSave={handleSaveDetails}
        onCancelEdit={handleCancelEdit}
        onArchive={handleArchive}
        onClone={() => setIsCloneDialogOpen(true)}
        onReleaseToManufacturing={
          canReleaseToManufacturing
            ? () => setIsMbomDialogOpen(true)
            : undefined
        }
        onGapAnalysis={() => setIsGapAnalysisOpen(true)}
      />

      {/* Clone Design Dialog */}
      <CloneDesignDialog
        open={isCloneDialogOpen}
        onOpenChange={setIsCloneDialogOpen}
        sourceDesignId={design.id}
        sourceDesignCode={design.code}
        sourceDesignName={design.name}
      />

      {/* Create MBOM Dialog */}
      {canReleaseToManufacturing && (
        <CreateMbomDialog
          open={isMbomDialogOpen}
          onOpenChange={setIsMbomDialogOpen}
          sourceDesignId={design.id}
          sourceDesignCode={design.code}
          sourceDesignName={design.name}
        />
      )}

      {/* Gap Analysis Dialog */}
      <GapAnalysisDialog
        open={isGapAnalysisOpen}
        onOpenChange={setIsGapAnalysisOpen}
        designId={design.id}
        designCode={design.code}
        designName={design.name}
      />

      {/* Upstream Changes Banner for Manufacturing Designs */}
      {isManufacturingDesign && !isHistoricalView && (
        <UpstreamChangesBanner designId={design.id} />
      )}

      {/* Design Details Section */}
      <DesignDetailsSection
        ref={detailsRef}
        design={design}
        programs={programs}
        isEditing={isEditingDetails}
        onEditEnd={() => setIsEditingDetails(false)}
        onUpdate={handleDetailsUpdate}
      />

      {/* Historical View Banner - only for regular designs */}
      {!isFamily && isHistoricalView && (
        <HistoricalViewBanner
          context={context}
          onReturnToCurrent={handleReturnToCurrent}
        />
      )}

      {/* Initial Release Helper - shown in pre-release phase, only for regular designs */}
      {!isFamily && !isHistoricalView && (
        <InitialReleaseHelper designId={design.id} />
      )}

      {/* Tabs - Different for Family vs Library vs Regular Designs */}
      {isFamily ? (
        /* Family Design Tabs - Only Members */
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList className="w-fit">
            <TabsTrigger value="members">Members</TabsTrigger>
          </TabsList>

          <TabsContent value="members" className="mt-6">
            <MembersTab
              designId={design.id}
              designCode={design.code}
              programId={design.programId}
            />
          </TabsContent>
        </Tabs>
      ) : isLibrary ? (
        /* Library Design Tabs - Items, History, ECOs, Baselines */
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="items">Items</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="ecos">ECOs</TabsTrigger>
            <TabsTrigger value="baselines">Baselines</TabsTrigger>
          </TabsList>

          <TabsContent value="items" className="mt-6">
            <LibraryItemsTab
              designId={design.id}
              versionContext={context}
              isHistoricalView={isHistoricalView}
            />
          </TabsContent>

          <TabsContent value="history" className="mt-6">
            <HistoryTab
              designId={design.id}
              versionContext={context}
              onViewHistoricalState={handleContextChange}
            />
          </TabsContent>

          <TabsContent value="ecos" className="mt-6">
            <ECOsTab
              designId={design.id}
              versionContext={context}
              isHistoricalView={isHistoricalView}
            />
          </TabsContent>

          <TabsContent value="baselines" className="mt-6">
            <BaselinesTab
              designId={design.id}
              tags={tags}
              versionContext={context}
              isHistoricalView={isHistoricalView}
              onViewBaseline={handleViewBaseline}
            />
          </TabsContent>
        </Tabs>
      ) : (
        /* Regular Design Tabs - Structure, History, ECOs, Baselines */
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="structure">Structure</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
            <TabsTrigger value="ecos">ECOs</TabsTrigger>
            <TabsTrigger value="baselines">Baselines</TabsTrigger>
          </TabsList>

          <TabsContent value="structure" className="mt-6">
            <StructureTab
              designId={design.id}
              designCode={design.code}
              designName={design.name}
              versionContext={context}
              isHistoricalView={isHistoricalView}
            />
          </TabsContent>

          <TabsContent value="history" className="mt-6">
            <HistoryTab
              designId={design.id}
              versionContext={context}
              onViewHistoricalState={handleContextChange}
            />
          </TabsContent>

          <TabsContent value="ecos" className="mt-6">
            <ECOsTab
              designId={design.id}
              versionContext={context}
              isHistoricalView={isHistoricalView}
            />
          </TabsContent>

          <TabsContent value="baselines" className="mt-6">
            <BaselinesTab
              designId={design.id}
              tags={tags}
              versionContext={context}
              isHistoricalView={isHistoricalView}
              onViewBaseline={handleViewBaseline}
            />
          </TabsContent>
        </Tabs>
      )}
    </PageContainer>
  )
}
