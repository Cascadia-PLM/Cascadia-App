// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import {
  ArrowRight,
  Box,
  Briefcase,
  GitBranch,
  Package,
  Plus,
} from 'lucide-react'
import type { Part } from '@/lib/items/types/part'
import { useTour } from '@/lib/tour'
import { PageContainer } from '@/components/layout'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import {
  dashboardChartsQuery,
  dashboardStatsQuery,
  itemCollectionQuery,
} from '@/lib/query'
import { DashboardCharts } from '@/components/dashboard'
import { StateBadge } from '@/components/items/StateBadge'

const recentPartsQuery = () =>
  itemCollectionQuery<Part>({ itemType: 'Part' }, 5)

export const Route = createFileRoute('/')({
  component: DashboardPage,
  // Three independent widgets: one of them failing should degrade to an
  // empty tile, not blank the whole dashboard.
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(recentPartsQuery()).catch(() => undefined),
      queryClient.ensureQueryData(dashboardStatsQuery()).catch(() => undefined),
      queryClient
        .ensureQueryData(dashboardChartsQuery())
        .catch(() => undefined),
    ])
  },
})

function DashboardPage() {
  const { data: parts = [] } = useQuery(recentPartsQuery())
  const { data: stats } = useQuery(dashboardStatsQuery())
  const { data: chartData } = useQuery(dashboardChartsQuery())
  const { triggerFirstTimeTour } = useTour()

  // Trigger guided tour for first-time users after login
  useEffect(() => {
    triggerFirstTimeTour()
  }, [triggerFirstTimeTour])

  // Get recent parts (last 5)
  const recentParts = [...parts]
    .sort((a, b) => {
      const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return dateB - dateA
    })
    .slice(0, 5)

  const dashboardCards = [
    {
      title: 'Parts',
      description: 'Manage your parts library',
      icon: <Package className="w-6 h-6" />,
      listHref: '/parts',
      createHref: '/parts/new',
      count: stats?.parts ?? 0,
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10',
    },
    {
      title: 'Designs',
      description: 'Engineering designs',
      icon: <Box className="w-6 h-6" />,
      listHref: '/designs',
      createHref: '/designs/new',
      count: stats?.designs ?? 0,
      color: 'text-purple-500',
      bgColor: 'bg-purple-500/10',
    },
    {
      title: 'Programs',
      description: 'Program management',
      icon: <Briefcase className="w-6 h-6" />,
      listHref: '/programs',
      createHref: '/programs/new',
      count: stats?.programs ?? 0,
      color: 'text-green-500',
      bgColor: 'bg-green-500/10',
    },
    {
      title: 'Change Orders',
      description: 'Engineering changes',
      icon: <GitBranch className="w-6 h-6" />,
      listHref: '/change-orders',
      createHref: '/change-orders/new',
      count: stats?.changeOrders ?? 0,
      color: 'text-orange-500',
      bgColor: 'bg-orange-500/10',
    },
  ]

  return (
    <PageContainer>
      {/* Header */}
      <div>
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
          Dashboard
        </h1>
        <p className="text-slate-600 dark:text-slate-400 mt-2">
          Welcome to Cascadia PLM
        </p>
      </div>

      {/* Dashboard Cards */}
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
        data-testid="dashboard-stats"
      >
        {dashboardCards.map((card) => (
          <Card
            key={card.listHref}
            className="hover:shadow-lg transition-shadow"
          >
            <CardHeader className="pb-3">
              <div className="flex items-start justify-between">
                <div className={`p-3 rounded-lg ${card.bgColor}`}>
                  <div className={card.color}>{card.icon}</div>
                </div>
                <div className="px-3 py-1 rounded-md bg-slate-100 dark:bg-slate-800 text-2xl font-bold text-slate-900 dark:text-white">
                  {card.count}
                </div>
              </div>
              <CardTitle className="text-xl mt-4">{card.title}</CardTitle>
              <CardDescription>{card.description}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                <Link to={card.listHref} className="flex-1 min-w-[80px]">
                  <Button variant="outline" className="w-full">
                    <ArrowRight className="w-4 h-4 mr-2" />
                    View
                  </Button>
                </Link>
                <Link to={card.createHref} className="flex-1 min-w-[80px]">
                  <Button className="w-full">
                    <Plus className="w-4 h-4 mr-2" />
                    Create
                  </Button>
                </Link>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Charts Section */}
      <DashboardCharts
        changeOrdersWeekly={chartData?.changeOrdersWeekly ?? []}
        partsReleasedWeekly={chartData?.partsReleasedWeekly ?? []}
        partsByType={chartData?.partsByType ?? []}
        tasksByPriority={chartData?.tasksByPriority ?? []}
      />

      {/* Recent Parts */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Recent Parts</CardTitle>
              <CardDescription>Latest created parts</CardDescription>
            </div>
            <Link to="/parts">
              <Button variant="ghost" size="sm">
                View All
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </Link>
          </div>
        </CardHeader>
        <CardContent>
          {recentParts.length === 0 ? (
            <div className="text-center py-8">
              <Package className="w-12 h-12 mx-auto text-slate-400 mb-4" />
              <p className="text-slate-600 dark:text-slate-400 mb-4">
                No parts yet
              </p>
              <Link to="/parts">
                <Button>
                  <Plus className="w-4 h-4 mr-2" />
                  Create First Part
                </Button>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
              {recentParts.map((part) => (
                <Link
                  key={part.id}
                  to="/parts/$id"
                  params={{ id: part.id! }}
                  className="block"
                >
                  <div className="flex items-center justify-between p-3 rounded-lg border border-slate-300 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 transition-colors">
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-slate-900 dark:text-white truncate">
                        {part.itemNumber}
                      </div>
                      <div className="text-sm text-slate-600 dark:text-slate-400 truncate">
                        {part.name}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 ml-2">
                      <StateBadge itemType="Part" state={part.state} />
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  )
}
