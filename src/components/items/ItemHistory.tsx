import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronUp, Clock, GitCommit, User } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface ItemRevision {
  id: string
  revision: string
  state: string
  isCurrent: boolean
  createdAt: string
  createdBy?: {
    id: string
    name: string
    email: string
  }
  commitMessage?: string
  branchName?: string
}

interface ItemHistoryProps {
  masterId: string
  designId?: string
  itemType: string
  maxVisible?: number
}

export function ItemHistory({
  masterId,
  designId,
  itemType,
  maxVisible = 5,
}: ItemHistoryProps) {
  const [revisions, setRevisions] = useState<Array<ItemRevision>>([])
  const [isLoading, setIsLoading] = useState(true)
  const [isExpanded, setIsExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchHistory() {
      if (!masterId) return

      setIsLoading(true)
      setError(null)
      try {
        const params = new URLSearchParams({ masterId })
        if (designId) params.append('designId', designId)

        const response = await fetch(`/api/v1/items/history?${params}`)
        if (!response.ok) {
          throw new Error('Failed to load history')
        }

        const data = await response.json()
        setRevisions(data.data?.revisions || [])
      } catch {
        setError('Unable to load revision history')
      } finally {
        setIsLoading(false)
      }
    }

    fetchHistory()
  }, [masterId, designId])

  const getStateColor = (
    state: string,
  ): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' => {
    const colors: Record<
      string,
      'default' | 'secondary' | 'success' | 'warning' | 'destructive'
    > = {
      Draft: 'secondary',
      InReview: 'default',
      Approved: 'success',
      Released: 'success',
      Obsolete: 'destructive',
    }
    return colors[state] ?? 'default'
  }

  const getItemRoute = () => {
    const typeRoutes: Record<string, string> = {
      Part: '/parts',
      Document: '/documents',
      Project: '/projects',
      Requirement: '/requirements',
      Task: '/tasks',
      ChangeOrder: '/change-orders',
    }
    return typeRoutes[itemType] || '/items'
  }

  const visibleRevisions = isExpanded
    ? revisions
    : revisions.slice(0, maxVisible)
  const hasMore = revisions.length > maxVisible

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Revision History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="animate-pulse space-y-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-16 bg-slate-100 dark:bg-slate-800 rounded-lg"
              />
            ))}
          </div>
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Revision History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500 dark:text-slate-400">{error}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Clock className="h-5 w-5" />
          Revision History
        </CardTitle>
        <CardDescription>
          {revisions.length} {revisions.length === 1 ? 'revision' : 'revisions'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {revisions.length > 0 ? (
          <div className="space-y-1">
            {/* Timeline */}
            <div className="relative">
              {visibleRevisions.map((revision, index) => (
                <div key={revision.id} className="relative flex gap-4 pb-4">
                  {/* Timeline line */}
                  {index < visibleRevisions.length - 1 && (
                    <div className="absolute left-3 top-8 bottom-0 w-px bg-slate-200 dark:bg-slate-700" />
                  )}

                  {/* Timeline dot */}
                  <div
                    className={`relative z-10 flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
                      revision.isCurrent
                        ? 'bg-cyan-500 text-white'
                        : 'bg-slate-200 dark:bg-slate-700 text-slate-500'
                    }`}
                  >
                    <GitCommit className="h-3 w-3" />
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Link
                        to={`${getItemRoute()}/$id` as any}
                        params={{ id: revision.id } as any}
                        className="font-medium text-cyan-600 dark:text-cyan-400 hover:underline"
                      >
                        Rev {revision.revision}
                      </Link>
                      <Badge variant={getStateColor(revision.state)}>
                        {revision.state}
                      </Badge>
                      {revision.isCurrent && (
                        <Badge variant="success">Current</Badge>
                      )}
                      {revision.branchName &&
                        revision.branchName !== 'main' && (
                          <Badge variant="warning">{revision.branchName}</Badge>
                        )}
                    </div>

                    <div className="flex items-center gap-4 mt-1 text-sm text-slate-500 dark:text-slate-400">
                      <span className="flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {new Date(revision.createdAt).toLocaleDateString()}
                      </span>
                      {revision.createdBy && (
                        <span className="flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {revision.createdBy.name || revision.createdBy.email}
                        </span>
                      )}
                    </div>

                    {revision.commitMessage && (
                      <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                        {revision.commitMessage}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Show more/less */}
            {hasMore && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExpanded(!isExpanded)}
                className="w-full mt-2"
              >
                {isExpanded ? (
                  <>
                    <ChevronUp className="h-4 w-4 mr-2" />
                    Show less
                  </>
                ) : (
                  <>
                    <ChevronDown className="h-4 w-4 mr-2" />
                    Show {revisions.length - maxVisible} more
                  </>
                )}
              </Button>
            )}
          </div>
        ) : (
          <p className="text-center text-slate-500 dark:text-slate-400 py-4">
            No revision history available
          </p>
        )}
      </CardContent>
    </Card>
  )
}
