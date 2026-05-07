import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import { z } from 'zod'
import type { ChangeOrder } from '@/lib/items/types/change-order'
import { PageContainer } from '@/components/layout'
import { ChangeOrderTable } from '@/components/change-orders/ChangeOrderTable'
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
import { apiFetch } from '@/lib/api/client'

// State counts interface matching server response
interface StateCounts {
  draft: number
  inReview: number
  released: number
}

// Search schema for URL validation
const changeOrdersSearchSchema = z.object({
  programId: z.string().uuid().optional(),
  designId: z.string().uuid().optional(),
  createNew: z.boolean().optional(),
})

export const Route = createFileRoute('/change-orders/')({
  validateSearch: changeOrdersSearchSchema,
  component: ChangeOrdersListPage,
  // Make loader depend on search params so it re-runs when they change
  loaderDeps: ({ search }) => ({
    designId: search.designId,
    programId: search.programId,
  }),
  loader: async ({ deps }) => {
    try {
      const { designId, programId } = deps
      const params = new URLSearchParams({
        itemType: 'ChangeOrder',
        limit: '10',
        offset: '0',
      })
      if (designId) params.set('designId', designId)

      // Build count params (mirror filters but not pagination)
      const countParams = new URLSearchParams({
        itemType: 'ChangeOrder',
        limit: '1',
      })
      if (designId) countParams.set('designId', designId)

      const [result, draftCount, inReviewCount, releasedCount] =
        await Promise.all([
          apiFetch<{ data: { items: Array<ChangeOrder>; total: number } }>(
            `/api/v1/items?${params}`,
          ),
          apiFetch<{ data: { total: number } }>(
            `/api/v1/items?${countParams}&state=Draft`,
          ).catch(() => ({ data: { total: 0 } })),
          apiFetch<{ data: { total: number } }>(
            `/api/v1/items?${countParams}&state=InReview`,
          ).catch(() => ({ data: { total: 0 } })),
          apiFetch<{ data: { total: number } }>(
            `/api/v1/items?${countParams}&state=Released`,
          ).catch(() => ({ data: { total: 0 } })),
        ])
      return {
        changeOrders: result.data.items,
        total: result.data.total,
        counts: {
          draft: draftCount.data.total,
          inReview: inReviewCount.data.total,
          released: releasedCount.data.total,
        } as StateCounts,
      }
    } catch (error) {
      console.error('Error loading change orders:', error)
      return {
        changeOrders: [] as Array<ChangeOrder>,
        total: 0,
        counts: { draft: 0, inReview: 0, released: 0 } as StateCounts,
      }
    }
  },
})

function ChangeOrdersListPage() {
  const router = useRouter()
  const navigate = useNavigate()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const {
    changeOrders: initialChangeOrders,
    total: initialTotal,
    counts: initialCounts,
  } = Route.useLoaderData()
  const searchParams = Route.useSearch()

  // State for server-side pagination
  const [changeOrders, setChangeOrders] =
    useState<Array<ChangeOrder>>(initialChangeOrders)
  const [total, setTotal] = useState<number>(initialTotal)
  const [counts, setCounts] = useState<StateCounts>(initialCounts)
  const [isLoading, setIsLoading] = useState(false)

  // Sync local state with loader data when it changes
  useEffect(() => {
    setChangeOrders(initialChangeOrders)
    setTotal(initialTotal)
    setCounts(initialCounts)
  }, [initialChangeOrders, initialTotal, initialCounts])

  // Handle page change for server-side pagination
  const handlePageChange = useCallback(
    async (page: number, pageSize: number) => {
      setIsLoading(true)
      try {
        const qp = new URLSearchParams({ itemType: 'ChangeOrder' })
        qp.set('limit', String(pageSize))
        qp.set('offset', String((page - 1) * pageSize))
        if (searchParams.designId) qp.set('designId', searchParams.designId)

        const result = await apiFetch<{
          data: { items: Array<ChangeOrder>; total: number }
        }>(`/api/v1/items?${qp}`)
        setChangeOrders(result.data.items)
        setTotal(result.data.total)
      } catch (error) {
        handleError(error, { title: 'Failed to load change orders' })
      } finally {
        setIsLoading(false)
      }
    },
    [searchParams.designId, searchParams.programId, handleError],
  )

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

          setChangeOrders(changeOrders.filter((co) => co.id !== changeOrder.id))
          showSuccess(
            'Change order deleted',
            `${changeOrder.itemNumber} has been deleted`,
          )

          // Reload to get fresh data from server
          router.invalidate()
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
            <CardTitle className="text-3xl">{counts.draft}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>In Review</CardDescription>
            <CardTitle className="text-3xl">{counts.inReview}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Released</CardDescription>
            <CardTitle className="text-3xl">{counts.released}</CardTitle>
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
            serverSidePagination
            totalRows={total}
            onPageChange={handlePageChange}
            isLoading={isLoading}
          />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
