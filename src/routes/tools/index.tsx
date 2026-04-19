import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Tool } from '@/lib/items/types/tool'
import { PageContainer } from '@/components/layout'
import { ToolTable } from '@/components/tools/ToolTable'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface ToolStateCounts {
  draft: number
  active: number
  maintenance: number
  retired: number
}

export const Route = createFileRoute('/tools/')({
  component: ToolsListPage,
  loader: async () => {
    try {
      const params = new URLSearchParams({
        itemType: 'Tool',
        limit: '50',
        offset: '0',
      })
      const result = await apiFetch<{
        data: { items: Array<Tool>; total: number }
      }>(`/api/items?${params}`)
      return {
        tools: result.data.items,
        total: result.data.total,
        counts: {
          draft: 0,
          active: 0,
          maintenance: 0,
          retired: 0,
        } as ToolStateCounts,
      }
    } catch (error) {
      console.error('Error loading tools:', error)
      return {
        tools: [] as Array<Tool>,
        total: 0,
        counts: {
          draft: 0,
          active: 0,
          maintenance: 0,
          retired: 0,
        } as ToolStateCounts,
      }
    }
  },
})

function ToolsListPage() {
  const navigate = useNavigate()
  const {
    tools: initialTools,
    total: initialTotal,
    counts: initialCounts,
  } = Route.useLoaderData()

  const [tools, setTools] = useState<Array<Tool>>(initialTools)
  const [total, setTotal] = useState(initialTotal)
  const [counts, setCounts] = useState<ToolStateCounts>(initialCounts)

  useEffect(() => {
    setTools(initialTools)
    setTotal(initialTotal)
    setCounts(initialCounts)
  }, [initialTools, initialTotal, initialCounts])

  const handleEditTool = (tool: { id?: string }) => {
    if (tool.id) {
      navigate({ to: '/tools/$id', params: { id: tool.id } })
    }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Tools
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manufacturing tools and equipment inventory
          </p>
        </div>
        <Link to="/tools/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create Tool
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Tools</CardDescription>
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
            <CardDescription>Active</CardDescription>
            <CardTitle className="text-3xl">{counts.active}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Maintenance</CardDescription>
            <CardTitle className="text-3xl">{counts.maintenance}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Retired</CardDescription>
            <CardTitle className="text-3xl">{counts.retired}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Tools Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Tools</CardTitle>
          <CardDescription>
            {total} {total === 1 ? 'tool' : 'tools'} in the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ToolTable items={tools} onSelect={handleEditTool} />
        </CardContent>
      </Card>
    </PageContainer>
  )
}
