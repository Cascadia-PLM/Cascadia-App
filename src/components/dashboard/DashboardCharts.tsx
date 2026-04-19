'use client'

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface WeeklyDataPoint {
  date: string
  count: number
}

interface CategoryDataPoint {
  name: string
  value: number
}

interface DashboardChartsProps {
  changeOrdersWeekly: Array<WeeklyDataPoint>
  partsReleasedWeekly: Array<WeeklyDataPoint>
  partsByType: Array<CategoryDataPoint>
  tasksByPriority: Array<CategoryDataPoint>
}

// Color palettes
const PART_TYPE_COLORS = ['#06b6d4', '#6b7280', '#22c55e', '#a3a3a3', '#3b82f6'] // cyan, gray, green, neutral, blue
const PRIORITY_COLORS: Record<string, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#22c55e',
  Unspecified: '#6b7280',
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatShortDate(dateStr: string): string {
  const date = new Date(dateStr)
  return date.toLocaleDateString('en-US', { weekday: 'short' })
}

export function ChangeOrdersChart({ data }: { data: Array<WeeklyDataPoint> }) {
  const total = data.reduce((sum, d) => sum + d.count, 0)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Change Orders Opened</CardTitle>
        <CardDescription>Last 7 days ({total} total)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={data}
              margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                className="stroke-slate-200 dark:stroke-slate-700"
              />
              <XAxis
                dataKey="date"
                tickFormatter={formatShortDate}
                tick={{ fill: 'currentColor', fontSize: 12 }}
                className="text-slate-600 dark:text-slate-400"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: 'currentColor', fontSize: 12 }}
                className="text-slate-600 dark:text-slate-400"
              />
              <Tooltip
                labelFormatter={formatDate}
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #fff)',
                  borderColor: 'var(--tooltip-border, #e2e8f0)',
                  borderRadius: '8px',
                }}
              />
              <Bar
                dataKey="count"
                fill="#f97316"
                radius={[4, 4, 0, 0]}
                name="Change Orders"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

export function PartsReleasedChart({ data }: { data: Array<WeeklyDataPoint> }) {
  const total = data.reduce((sum, d) => sum + d.count, 0)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Parts Released</CardTitle>
        <CardDescription>Last 7 days ({total} total)</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={data}
              margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                className="stroke-slate-200 dark:stroke-slate-700"
              />
              <XAxis
                dataKey="date"
                tickFormatter={formatShortDate}
                tick={{ fill: 'currentColor', fontSize: 12 }}
                className="text-slate-600 dark:text-slate-400"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: 'currentColor', fontSize: 12 }}
                className="text-slate-600 dark:text-slate-400"
              />
              <Tooltip
                labelFormatter={formatDate}
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #fff)',
                  borderColor: 'var(--tooltip-border, #e2e8f0)',
                  borderRadius: '8px',
                }}
              />
              <Bar
                dataKey="count"
                fill="#22c55e"
                radius={[4, 4, 0, 0]}
                name="Parts Released"
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

export function PartTypeChart({ data }: { data: Array<CategoryDataPoint> }) {
  const total = data.reduce((sum, d) => sum + d.value, 0)

  if (total === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Parts by Type</CardTitle>
          <CardDescription>Distribution of part types</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[200px] flex items-center justify-center text-slate-500 dark:text-slate-400">
            No parts data available
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Parts by Type</CardTitle>
        <CardDescription>{total} total parts</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height={200}>
            <PieChart>
              <Pie
                data={data as unknown as Array<{ name: string; value: number }>}
                cx="50%"
                cy="50%"
                innerRadius={40}
                outerRadius={65}
                paddingAngle={2}
                dataKey="value"
              >
                {data.map((_, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={PART_TYPE_COLORS[index % PART_TYPE_COLORS.length]}
                  />
                ))}
              </Pie>
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #fff)',
                  borderColor: 'var(--tooltip-border, #e2e8f0)',
                  borderRadius: '8px',
                }}
                formatter={(value) => [`${value} parts`, '']}
              />
              <Legend
                formatter={(value: string) => {
                  const item = data.find((d) => d.name === value)
                  const percent = item
                    ? ((item.value / total) * 100).toFixed(0)
                    : 0
                  return `${value} (${percent}%)`
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

export function TasksByPriorityChart({
  data,
}: {
  data: Array<CategoryDataPoint>
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0)

  // Sort by priority order
  const priorityOrder = ['high', 'medium', 'low', 'Unspecified']
  const sortedData = [...data].sort((a, b) => {
    const aIndex = priorityOrder.indexOf(a.name.toLowerCase())
    const bIndex = priorityOrder.indexOf(b.name.toLowerCase())
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex)
  })

  if (total === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg">Open Tasks by Priority</CardTitle>
          <CardDescription>Task distribution by priority level</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="h-[200px] flex items-center justify-center text-slate-500 dark:text-slate-400">
            No open tasks
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Open Tasks by Priority</CardTitle>
        <CardDescription>{total} open tasks</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height={200}>
            <BarChart
              data={sortedData}
              layout="vertical"
              margin={{ top: 10, right: 30, left: 60, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                className="stroke-slate-200 dark:stroke-slate-700"
              />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fill: 'currentColor', fontSize: 12 }}
                className="text-slate-600 dark:text-slate-400"
              />
              <YAxis
                dataKey="name"
                type="category"
                tick={{ fill: 'currentColor', fontSize: 12 }}
                className="text-slate-600 dark:text-slate-400"
                width={50}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #fff)',
                  borderColor: 'var(--tooltip-border, #e2e8f0)',
                  borderRadius: '8px',
                }}
              />
              <Bar dataKey="value" name="Tasks" radius={[0, 4, 4, 0]}>
                {sortedData.map((entry, index) => (
                  <Cell
                    key={`cell-${index}`}
                    fill={
                      PRIORITY_COLORS[entry.name.toLowerCase()] ||
                      PRIORITY_COLORS['Unspecified']
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  )
}

export function DashboardCharts({
  changeOrdersWeekly,
  partsReleasedWeekly,
  partsByType,
  tasksByPriority,
}: DashboardChartsProps) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChangeOrdersChart data={changeOrdersWeekly} />
      <PartsReleasedChart data={partsReleasedWeekly} />
      <PartTypeChart data={partsByType} />
      <TasksByPriorityChart data={tasksByPriority} />
    </div>
  )
}
