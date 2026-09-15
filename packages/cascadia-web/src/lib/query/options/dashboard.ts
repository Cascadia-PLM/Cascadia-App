// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { queryOptions } from '@tanstack/react-query'
import { qk } from '../keys'
import { apiFetch } from '@/lib/api/client'

export interface DashboardStats {
  parts: number
  documents: number
  changeOrders: number
  requirements: number
  tasks: number
  designs: number
  programs: number
}

export interface DashboardSeriesPoint {
  date: string
  count: number
}

export interface DashboardCategoryPoint {
  name: string
  value: number
}

export interface DashboardChartData {
  changeOrdersWeekly: Array<DashboardSeriesPoint>
  partsReleasedWeekly: Array<DashboardSeriesPoint>
  partsByType: Array<DashboardCategoryPoint>
  tasksByPriority: Array<DashboardCategoryPoint>
}

/**
 * Item totals per type, counted server-side.
 *
 * Keyed under `dashboard`, which every item-typed resource reaches through
 * `items` — so creating a part refreshes the tile that counts them.
 */
export function dashboardStatsQuery() {
  return queryOptions({
    queryKey: qk.collection('dashboard', 'stats'),
    queryFn: async (): Promise<DashboardStats> => {
      const result = await apiFetch<{ data: { stats: DashboardStats } }>(
        '/api/v1/dashboard/stats',
      )
      return result.data.stats
    },
  })
}

/** The dashboard's weekly series and category breakdowns. */
export function dashboardChartsQuery() {
  return queryOptions({
    queryKey: qk.collection('dashboard', 'charts'),
    queryFn: async (): Promise<DashboardChartData> => {
      const result = await apiFetch<{ data: DashboardChartData }>(
        '/api/v1/dashboard/charts',
      )
      return result.data
    },
  })
}
