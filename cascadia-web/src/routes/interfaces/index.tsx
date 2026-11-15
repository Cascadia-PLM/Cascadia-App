// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { InterfaceItem } from '@cascadia/commons/items/types/interface'
import type { ItemFilters } from '@/query'
import { PageContainer } from '@/components/layout'
import { InterfaceTable } from '@/components/interfaces/InterfaceTable'
import { useVersionContext } from '@/hooks/useVersionContext'
import { useServerDataGrid } from '@/hooks/useServerDataGrid'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/hooks/useAlertDialog'
import { useErrorHandler } from '@/hooks/useErrorHandler'
import {
  designListQuery,
  gridParamsFromSearch,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
  lifecycleByItemTypeQuery,
  useInvalidateResources,
} from '@/query'
import { apiFetch } from '@/api/client'
import { LifecycleStateCards } from '@/components/items/LifecycleStateCards'

// Search schema for URL validation
const interfacesSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  filter_state: z.coerce.string().optional(),
  filter_interfaceKind: z.coerce.string().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  // Version context params
  branch: z.string().uuid().optional(),
  tag: z.string().uuid().optional(),
  commit: z.string().uuid().optional(),
})

type InterfacesSearch = z.infer<typeof interfacesSearchSchema>

// Shared by the loader and the component so both key on identical filters.
function interfaceFilters(search: InterfacesSearch): ItemFilters {
  return {
    itemType: 'Interface',
    programId: search.programId,
    designId: search.designId,
    branch: search.branch,
    tag: search.tag,
    commit: search.commit,
  }
}

export const Route = createFileRoute('/interfaces/')({
  validateSearch: interfacesSearchSchema,
  component: InterfacesListPage,
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = interfaceFilters(deps)
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<InterfaceItem>(filters, gridParamsFromSearch(deps)),
      ),
      (async () => {
        const lifecycle = await queryClient.ensureQueryData(
          lifecycleByItemTypeQuery('Interface'),
        )
        await queryClient.ensureQueryData(
          itemCountsQuery(
            filters,
            lifecycle.states.map((state) => state.id),
          ),
        )
      })(),
      queryClient.ensureQueryData(designListQuery()),
    ])
  },
})

function InterfacesListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()
  const filters = interfaceFilters(searchParams)

  const { data: designs = [] } = useQuery(designListQuery())
  const {
    items: interfaces,
    total,
    dataGridProps,
  } = useServerDataGrid<InterfaceItem>({
    query: itemGridQuery<InterfaceItem>(filters),
  })

  const selectedDesignId = searchParams.designId
  const selectedDesign = designs.find((d) => d.id === selectedDesignId)
  const { context, contextLabel, isEditable } =
    useVersionContext(selectedDesignId)

  const handleEdit = (iface: InterfaceItem) => {
    if (iface.id) {
      navigate({ to: '/interfaces/$id', params: { id: iface.id } })
    }
  }

  const handleDelete = (iface: InterfaceItem) => {
    if (!iface.id) return
    confirm({
      title: 'Delete Interface',
      description: `Are you sure you want to delete ${iface.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/interfaces/${iface.id}`, {
            method: 'DELETE',
          })
          showSuccess(
            'Interface deleted',
            `${iface.itemNumber} has been deleted`,
          )
          await invalidate('interfaces')
        } catch (error) {
          handleError(error, { title: 'Failed to delete interface' })
        }
      },
    })
  }

  const getContextBadgeVariant = () => {
    switch (context.type) {
      case 'branch':
        return 'secondary'
      case 'tag':
      case 'commit':
        return 'outline'
      default:
        return 'default'
    }
  }

  return (
    <PageContainer>
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
              Interfaces
            </h1>
            {selectedDesignId && (
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {contextLabel}
              </Badge>
            )}
          </div>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            What joins the system elements: buses, networks, mounts and loops,
            each an item in its own right
            {selectedDesign && (
              <span className="text-slate-500"> in {selectedDesign.name}</span>
            )}
          </p>
        </div>
        <Link
          to="/interfaces/new"
          search={selectedDesignId ? { designId: selectedDesignId } : {}}
        >
          <Button disabled={!isEditable && context.type !== 'main'}>
            <Plus className="h-4 w-4 mr-2" />
            Create Interface
          </Button>
        </Link>
      </div>

      {/* Stats — one card per lifecycle state, from configuration */}
      <LifecycleStateCards
        itemType="Interface"
        filters={filters}
        total={total}
        totalLabel="Total Interfaces"
      />

      <Card>
        <CardHeader>
          <CardTitle>All Interfaces</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'interface' : 'interfaces'} in the
            system
            {selectedDesign && context.type !== 'main' && (
              <span className="ml-2 text-amber-600 dark:text-amber-400">
                (viewing {contextLabel})
              </span>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <InterfaceTable
            interfaces={interfaces}
            onEdit={handleEdit}
            onDelete={handleDelete}
            serverSidePagination={dataGridProps.serverSidePagination}
            totalRows={dataGridProps.totalRows}
            onPageChange={dataGridProps.onPageChange}
            isLoading={dataGridProps.isLoading}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
