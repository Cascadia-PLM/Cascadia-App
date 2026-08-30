// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type { DesignDetailsSectionHandle } from '@/components/designs/DesignDetailsSection'
import type { Branch, TagItem } from '@/components/designs/DesignPageHeader'
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
import { ScopeGraphView } from '@/components/graph/ScopeGraphView'
import {
  Card,
  CardContent,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { useVersionContext } from '@/lib/hooks/useVersionContext'
import {
  designBranchesQuery,
  designDetailQuery,
  designTagsQuery,
  programListQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

/** The tabs the design page renders; the search schema derives from this list. */
const DESIGN_DETAIL_TABS = [
  'structure',
  'items',
  'graph',
  'history',
  'ecos',
  'baselines',
  'members',
] as const
type DesignDetailTab = (typeof DESIGN_DETAIL_TABS)[number]

// Search schema for URL validation
const designSearchSchema = z.object({
  tab: z.enum(DESIGN_DETAIL_TABS).optional(),
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
  loader: async ({ context: { queryClient }, params }) => {
    await Promise.all([
      queryClient.ensureQueryData(designDetailQuery(params.id)),
      queryClient.ensureQueryData(designBranchesQuery(params.id)),
      queryClient.ensureQueryData(designTagsQuery(params.id)),
      queryClient.ensureQueryData(programListQuery()),
    ])
  },
})

function DesignDetailPage() {
  const { id } = Route.useParams()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()
  const detailsRef = useRef<DesignDetailsSectionHandle>(null)
  const [isEditingDetails, setIsEditingDetails] = useState(false)
  const [isSavingDetails, setIsSavingDetails] = useState(false)
  const [isCloneDialogOpen, setIsCloneDialogOpen] = useState(false)
  const [isMbomDialogOpen, setIsMbomDialogOpen] = useState(false)
  const [isGapAnalysisOpen, setIsGapAnalysisOpen] = useState(false)

  const { data: design } = useQuery(designDetailQuery(id))
  const { data: branches = [] } = useQuery(designBranchesQuery<Branch>(id))
  const { data: tags = [] } = useQuery(designTagsQuery<TagItem>(id))
  const { data: programs = [] } = useQuery(programListQuery())

  // Version context from URL
  const { context, isHistoricalView, setContext, setMainContext } =
    useVersionContext(id)

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
    void invalidate('designs')
  }

  if (!design) return null

  // Check if this is an Engineering design that can be released to manufacturing
  const canReleaseToManufacturing = design.designType === 'Engineering'

  // Check if this is a Manufacturing design that should show upstream changes
  const isManufacturingDesign = design.designType === 'Manufacturing'

  // Determine if this is a family or library design
  const isFamily = design.designType === 'Family'
  const isLibrary = design.designType === 'Library'

  // Active tab from URL (default varies by design type)
  const activeTab =
    searchParams.tab ||
    (isFamily ? 'members' : isLibrary ? 'items' : 'structure')

  // Handle tab change
  const handleTabChange = (tab: DesignDetailTab) => {
    navigate({
      to: '/designs/$id',
      params: { id },
      search: (prev: z.infer<typeof designSearchSchema>) => ({
        ...prev,
        tab,
      }),
    })
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
          await apiFetch(`/api/v1/designs/${id}`, {
            method: 'DELETE',
          })

          showSuccess('Design archived', `${design.code} has been archived`)
          await invalidate('designs')
          navigate({ to: '/designs' })
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
          onValueChange={(value) => handleTabChange(value as DesignDetailTab)}
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
          onValueChange={(value) => handleTabChange(value as DesignDetailTab)}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="items">Items</TabsTrigger>
            <TabsTrigger value="graph">Graph</TabsTrigger>
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

          <TabsContent value="graph" className="mt-6">
            <Card>
              <CardContent className="pt-6">
                <ScopeGraphView rootType="design" rootId={design.id} />
              </CardContent>
            </Card>
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
          onValueChange={(value) => handleTabChange(value as DesignDetailTab)}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="structure">Structure</TabsTrigger>
            <TabsTrigger value="graph">Graph</TabsTrigger>
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

          <TabsContent value="graph" className="mt-6">
            <Card>
              <CardContent className="pt-6">
                <ScopeGraphView rootType="design" rootId={design.id} />
              </CardContent>
            </Card>
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
