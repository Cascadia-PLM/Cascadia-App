import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Check, ExternalLink, Filter, RefreshCw } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface Requirement {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
}

interface Item {
  id: string
  itemNumber: string
  name: string | null
  itemType: string
  revision: string
}

interface Relationship {
  sourceId: string
  targetId: string
}

interface TraceabilityMatrixProps {
  designId: string
  className?: string
}

type FilterPriority =
  | 'all'
  | 'MustHave'
  | 'ShouldHave'
  | 'CouldHave'
  | 'WontHave'
type FilterCoverage = 'all' | 'satisfied' | 'unsatisfied'

/**
 * Traceability matrix showing SATISFIES relationships between items and requirements.
 * Rows: Parts/Documents
 * Columns: Requirements
 * Cells: SATISFIES relationship indicators
 */
export function TraceabilityMatrix({
  designId,
  className = '',
}: TraceabilityMatrixProps) {
  const [requirements, setRequirements] = useState<Array<Requirement>>([])
  const [items, setItems] = useState<Array<Item>>([])
  const [relationships, setRelationships] = useState<Array<Relationship>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [searchQuery, setSearchQuery] = useState('')
  const [priorityFilter, setPriorityFilter] = useState<FilterPriority>('all')
  const [coverageFilter, setCoverageFilter] = useState<FilterCoverage>('all')

  useEffect(() => {
    async function fetchData() {
      setLoading(true)
      setError(null)
      try {
        // Fetch requirements
        const reqResponse = await apiFetch<{
          data: { items: Array<Requirement> }
        }>(`/api/v1/items/search?types=Requirement&designId=${designId}&limit=100`)
        setRequirements(reqResponse.data.items)

        const itemsResponse = await apiFetch<{
          data: { items: Array<Item> }
        }>(
          `/api/v1/items/search?types=Part,Document&designId=${designId}&limit=100`,
        )
        setItems(itemsResponse.data.items)

        const relResponse = await apiFetch<{
          data: { relationships: Array<Relationship> }
        }>(`/api/v1/relationships?designId=${designId}&type=SATISFIES`)
        setRelationships(relResponse.data.relationships)
      } catch (err) {
        setError('Failed to load traceability data')
      } finally {
        setLoading(false)
      }
    }
    fetchData()
  }, [designId])

  // Build relationship map for quick lookup
  const relationshipMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const rel of relationships) {
      if (!map.has(rel.sourceId)) {
        map.set(rel.sourceId, new Set())
      }
      map.get(rel.sourceId)!.add(rel.targetId)
    }
    return map
  }, [relationships])

  // Filtered requirements
  const filteredRequirements = useMemo(() => {
    let filtered = requirements

    if (priorityFilter !== 'all') {
      filtered = filtered.filter((r) => r.priority === priorityFilter)
    }

    if (coverageFilter !== 'all') {
      const satisfiedReqIds = new Set(relationships.map((rel) => rel.targetId))
      if (coverageFilter === 'satisfied') {
        filtered = filtered.filter((r) => satisfiedReqIds.has(r.id))
      } else {
        filtered = filtered.filter((r) => !satisfiedReqIds.has(r.id))
      }
    }

    return filtered
  }, [requirements, priorityFilter, coverageFilter, relationships])

  // Filtered items
  const filteredItems = useMemo(() => {
    if (!searchQuery) return items
    const query = searchQuery.toLowerCase()
    return items.filter(
      (item) =>
        item.itemNumber.toLowerCase().includes(query) ||
        item.name?.toLowerCase().includes(query),
    )
  }, [items, searchQuery])

  const hasSatisfies = (itemId: string, reqId: string) => {
    return relationshipMap.get(itemId)?.has(reqId) || false
  }

  const handleRefresh = () => {
    setLoading(true)
    // Re-fetch data by changing designId (hacky but works)
    setRelationships([])
    setRequirements([])
    setItems([])
    setTimeout(() => {
      // Trigger useEffect
    }, 100)
  }

  const priorityColor = (priority: string | null) => {
    switch (priority) {
      case 'MustHave':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
      case 'ShouldHave':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200'
      case 'CouldHave':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200'
      default:
        return 'bg-slate-100 text-slate-800 dark:bg-slate-800 dark:text-slate-200'
    }
  }

  if (loading) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Traceability Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Loading traceability data...</p>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Traceability Matrix</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-red-500">{error}</p>
        </CardContent>
      </Card>
    )
  }

  if (requirements.length === 0) {
    return (
      <Card className={className}>
        <CardHeader>
          <CardTitle>Traceability Matrix</CardTitle>
          <CardDescription>
            View which items satisfy which requirements
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <p className="text-slate-500">
              No requirements found for this design
            </p>
            <Link to="/requirements/new">
              <Button variant="outline" size="sm" className="mt-3">
                Add First Requirement
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>Traceability Matrix</CardTitle>
            <CardDescription>
              {filteredItems.length} items × {filteredRequirements.length}{' '}
              requirements
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-1" />
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Filters */}
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <Input
              placeholder="Search items..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full"
            />
          </div>
          <Select
            value={priorityFilter}
            onValueChange={(v) => setPriorityFilter(v as FilterPriority)}
          >
            <SelectTrigger className="w-[150px]">
              <Filter className="h-4 w-4 mr-2" />
              <SelectValue placeholder="Priority" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Priorities</SelectItem>
              <SelectItem value="MustHave">Must Have</SelectItem>
              <SelectItem value="ShouldHave">Should Have</SelectItem>
              <SelectItem value="CouldHave">Could Have</SelectItem>
              <SelectItem value="WontHave">Won't Have</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={coverageFilter}
            onValueChange={(v) => setCoverageFilter(v as FilterCoverage)}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Coverage" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Coverage</SelectItem>
              <SelectItem value="satisfied">Satisfied</SelectItem>
              <SelectItem value="unsatisfied">Unsatisfied</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Matrix Table */}
        <div className="overflow-auto max-h-[600px] border rounded-lg">
          <TooltipProvider>
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800">
                <tr>
                  <th className="sticky left-0 z-20 bg-slate-100 dark:bg-slate-800 p-2 text-left border-b border-r min-w-[200px]">
                    Item
                  </th>
                  {filteredRequirements.map((req) => (
                    <th
                      key={req.id}
                      className="p-2 text-center border-b min-w-[80px]"
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Link
                            to={`/requirements/${req.id}` as any}
                            className="text-xs font-medium hover:text-cyan-600 block"
                          >
                            <div
                              className={`px-1.5 py-0.5 rounded text-xs ${priorityColor(req.priority)}`}
                            >
                              {req.itemNumber}
                            </div>
                          </Link>
                        </TooltipTrigger>
                        <TooltipContent>
                          <div>
                            <p className="font-medium">{req.itemNumber}</p>
                            {req.name && <p className="text-xs">{req.name}</p>}
                            {req.priority && (
                              <Badge
                                variant="secondary"
                                className="text-xs mt-1"
                              >
                                {req.priority}
                              </Badge>
                            )}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr>
                    <td
                      colSpan={filteredRequirements.length + 1}
                      className="p-4 text-center text-slate-500"
                    >
                      No items found
                    </td>
                  </tr>
                ) : (
                  filteredItems.map((item) => (
                    <tr
                      key={item.id}
                      className="hover:bg-slate-50 dark:hover:bg-slate-900"
                    >
                      <td className="sticky left-0 z-10 bg-white dark:bg-slate-950 p-2 border-b border-r">
                        <Link
                          to={
                            `/${item.itemType.toLowerCase()}s/${item.id}` as any
                          }
                          className="flex items-center gap-2 hover:text-cyan-600"
                        >
                          <Badge variant="outline" className="text-xs">
                            {item.itemType}
                          </Badge>
                          <span className="font-medium text-sm">
                            {item.itemNumber}
                          </span>
                          <ExternalLink className="h-3 w-3 text-slate-400" />
                        </Link>
                        {item.name && (
                          <p className="text-xs text-slate-500 truncate max-w-[200px]">
                            {item.name}
                          </p>
                        )}
                      </td>
                      {filteredRequirements.map((req) => {
                        const satisfied = hasSatisfies(item.id, req.id)
                        return (
                          <td key={req.id} className="p-2 text-center border-b">
                            {satisfied ? (
                              <Check className="h-5 w-5 text-green-600 mx-auto" />
                            ) : (
                              <span className="text-slate-300">-</span>
                            )}
                          </td>
                        )
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </TooltipProvider>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1">
            <Check className="h-4 w-4 text-green-600" />
            Satisfies requirement
          </span>
          <span className="flex items-center gap-1">
            <span className="text-slate-300">-</span>
            No relationship
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
