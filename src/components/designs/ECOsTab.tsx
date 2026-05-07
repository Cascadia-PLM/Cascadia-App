import { useEffect, useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  Ban,
  Check,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import { Badge, Button, Card, CardContent } from '@/components/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { apiFetch } from '@/lib/api/client'

interface ECOSummary {
  id: string
  itemNumber: string
  name: string
  state: string
  reasonForChange: string
  itemCount: number
  owner: { id: string; name: string }
  createdAt: string
  submittedAt?: string
  releasedAt?: string
}

interface ECOsTabProps {
  designId: string
  versionContext: VersionContext
  isHistoricalView: boolean
  onCreateECO?: () => void
}

export function ECOsTab({
  designId,
  isHistoricalView,
  onCreateECO,
}: ECOsTabProps) {
  const [loading, setLoading] = useState(true)
  const [ecos, setEcos] = useState<Array<ECOSummary>>([])
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [error, setError] = useState<string | null>(null)

  // Fetch ECOs
  useEffect(() => {
    async function fetchECOs() {
      setLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams()
        if (statusFilter !== 'all') {
          params.set('status', statusFilter)
        }

        const response = await apiFetch<{
          data: { ecos: Array<ECOSummary>; total: number }
        }>(`/api/v1/designs/${designId}/ecos?${params.toString()}`)

        setEcos(response.data.ecos)
      } catch {
        setError(
          'Failed to load ECOs. The API endpoint may not be implemented yet.',
        )
        setEcos([])
      } finally {
        setLoading(false)
      }
    }

    fetchECOs()
  }, [designId, statusFilter])

  // Filter ECOs by status
  const filteredECOs = useMemo(() => {
    if (statusFilter === 'all') return ecos
    return ecos.filter((eco) => eco.state === statusFilter)
  }, [ecos, statusFilter])

  // Get status icon
  const getStatusIcon = (state: string) => {
    switch (state) {
      case 'Draft':
      case 'Pending':
        return <RefreshCw className="h-4 w-4 text-slate-400" />
      case 'InReview':
        return <Search className="h-4 w-4 text-amber-500" />
      case 'Approved':
      case 'Released':
        return <Check className="h-4 w-4 text-green-500" />
      case 'Rejected':
        return <X className="h-4 w-4 text-red-500" />
      case 'Cancelled':
        return <Ban className="h-4 w-4 text-slate-400" />
      default:
        return <RefreshCw className="h-4 w-4 text-slate-400" />
    }
  }

  // Get status badge variant
  const getStatusBadgeVariant = (state: string) => {
    switch (state) {
      case 'Draft':
      case 'Pending':
        return 'secondary' as const
      case 'InReview':
        return 'warning' as const
      case 'Approved':
      case 'Released':
        return 'success' as const
      case 'Rejected':
        return 'destructive' as const
      case 'Cancelled':
        return 'outline' as const
      default:
        return 'default' as const
    }
  }

  // Get status label
  const getStatusLabel = (state: string) => {
    switch (state) {
      case 'Draft':
        return 'In Work'
      case 'Pending':
        return 'In Work'
      case 'InReview':
        return 'In Review'
      case 'Approved':
        return 'Approved'
      case 'Released':
        return 'Released'
      case 'Rejected':
        return 'Rejected'
      case 'Cancelled':
        return 'Cancelled'
      default:
        return state
    }
  }

  // Get time since
  const getTimeSince = (dateStr: string) => {
    const date = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    if (diffDays === 0) return 'Today'
    if (diffDays === 1) return 'Yesterday'
    if (diffDays < 7) return `${diffDays} days ago`
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`
    return date.toLocaleDateString()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">Status:</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="Draft">In Work</SelectItem>
              <SelectItem value="InReview">In Review</SelectItem>
              <SelectItem value="Released">Released</SelectItem>
              <SelectItem value="Rejected">Rejected</SelectItem>
              <SelectItem value="Cancelled">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {onCreateECO && (
          <Button onClick={onCreateECO} disabled={isHistoricalView}>
            <Plus className="h-4 w-4 mr-2" />
            New ECO
          </Button>
        )}
      </div>

      {/* Error message */}
      {error && (
        <Card className="border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800">
          <CardContent className="py-4">
            <p className="text-amber-700 dark:text-amber-300">{error}</p>
            <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">
              This feature requires the ECOs API endpoint to be implemented.
            </p>
          </CardContent>
        </Card>
      )}

      {/* ECO Cards */}
      {filteredECOs.length > 0 ? (
        <div className="space-y-4">
          {filteredECOs.map((eco) => (
            <Card
              key={eco.id}
              className="hover:border-slate-300 dark:hover:border-slate-600 transition-colors"
            >
              <CardContent className="py-4">
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-4">
                    {/* Status Icon */}
                    <div className="mt-1 p-2 rounded-full bg-slate-100 dark:bg-slate-800">
                      {getStatusIcon(eco.state)}
                    </div>

                    {/* Content */}
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-lg text-slate-900 dark:text-white">
                          {eco.itemNumber}
                        </span>
                        <Badge variant={getStatusBadgeVariant(eco.state)}>
                          {getStatusLabel(eco.state)}
                        </Badge>
                      </div>
                      <p className="text-slate-600 dark:text-slate-400 mt-1">
                        {eco.reasonForChange || eco.name || 'No description'}
                      </p>
                      <div className="flex items-center gap-4 mt-2 text-sm text-slate-500">
                        <span>{eco.itemCount} items</span>
                        <span>{eco.owner.name}</span>
                        <span>
                          {eco.state === 'Released' && eco.releasedAt
                            ? `Released ${getTimeSince(eco.releasedAt)}`
                            : `Started ${getTimeSince(eco.createdAt)}`}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  {}
                  <Link to={`/change-orders/${eco.id}` as any}>
                    <Button variant="outline" size="sm">
                      <ExternalLink className="h-3 w-3 mr-1" />
                      View ECO
                    </Button>
                  </Link>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        !error && (
          <Card>
            <CardContent className="py-8">
              <div className="text-center text-slate-500 dark:text-slate-400">
                {ecos.length === 0
                  ? 'No ECOs found for this design.'
                  : 'No ECOs match the selected filter.'}
              </div>
            </CardContent>
          </Card>
        )
      )}
    </div>
  )
}
