// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import type { ItemFilters } from '@/lib/query'
import { PageContainer } from '@/components/layout'
import { ChangeOrderTable } from '@/components/change-orders/ChangeOrderTable'
import { useServerDataGrid } from '@/lib/hooks/useServerDataGrid'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  gridParamsFromSearch,
  itemCountsQuery,
  itemGridQuery,
  itemListQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

// The states behind the stat cards, counted in one request rather than one
// probe request each.
const COUNT_STATES = ['Draft', 'InReview', 'Released']

// Search schema for URL validation. The grid params are validated here too —
// anything the schema drops is a param `useServerDataGrid` cannot round-trip
// through the URL.
const changeOrdersSearchSchema = z.object({
  search: z.coerce.string().optional(),
  sortBy: z.string().optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().optional(),
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  createNew: z.boolean().optional(),
})

type ChangeOrdersSearch = z.infer<typeof changeOrdersSearchSchema>

// Shared by the loader and the component so both key on identical filters.
function changeOrderFilters(search: ChangeOrdersSearch): ItemFilters {
  return {
    itemType: 'ChangeOrder',
    programId: search.programId,
    designId: search.designId,
  }
}

export const Route = createFileRoute('/change-orders/')({
  validateSearch: changeOrdersSearchSchema,
  component: ChangeOrdersListPage,
  // The whole search object, so the loader can derive the very same grid
  // params the component derives — same params, same query key, one fetch.
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const filters = changeOrderFilters(deps)
    await Promise.all([
      queryClient.ensureQueryData(
        itemListQuery<ChangeOrder>(filters, gridParamsFromSearch(deps)),
      ),
      queryClient.ensureQueryData(itemCountsQuery(filters, COUNT_STATES)),
    ])
  },
})

function ChangeOrdersListPage() {
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  const searchParams = Route.useSearch()

  const filters = changeOrderFilters(searchParams)

  const { data: counts } = useQuery(itemCountsQuery(filters, COUNT_STATES))

  const {
    items: changeOrders,
    total,
    dataGridProps,
  } = useServerDataGrid<ChangeOrder>({
    query: itemGridQuery<ChangeOrder>(filters),
  })

  // Navigate to detail page for editing
  const handleEditChangeOrder = (changeOrder: ChangeOrder) => {
    if (changeOrder.id) {
      navigate({ to: '/change-orders/$id', params: { id: changeOrder.id } })
    }
  }

  const handleDeleteChangeOrder = (changeOrder: ChangeOrder) => {
    if (!changeOrder.id) return

    confirm({
      title: 'Delete Change Order',
      description: `Are you sure you want to delete ${changeOrder.itemNumber}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/change-orders/${changeOrder.id}`, {
            method: 'DELETE',
          })

          showSuccess(
            'Change order deleted',
            `${changeOrder.itemNumber} has been deleted`,
          )
          await invalidate('change-orders')
        } catch (error) {
          handleError(error, { title: 'Failed to delete change order' })
        }
      },
    })
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Change Orders
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manage engineering change orders and impact assessments
          </p>
        </div>
        <Link to="/change-orders/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Change Order
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Change Orders</CardDescription>
            <CardTitle className="text-3xl">{total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Draft</CardDescription>
            <CardTitle className="text-3xl">{counts?.Draft ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts?.InReview ?? 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts?.Released ?? 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Change Orders Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Change Orders</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'change order' : 'change orders'} in the
            system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangeOrderTable
            items={changeOrders}
            onEdit={handleEditChangeOrder}
            onDelete={handleDeleteChangeOrder}
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
