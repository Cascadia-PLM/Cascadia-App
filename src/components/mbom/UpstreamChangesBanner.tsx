import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  RefreshCw,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { UpstreamChangeItem } from '@/lib/db/schema/thread'
import { Button } from '@/components/ui/Button'

interface UpstreamChange {
  id: string
  sourceDesignId: string
  sourceDesignName: string
  sourceDesignCode: string
  sourceEcoNumber: string | null
  changedItems: Array<UpstreamChangeItem>
  status: string
  createdAt: string
}

interface UpstreamChangesBannerProps {
  designId: string
}

export function UpstreamChangesBanner({
  designId,
}: UpstreamChangesBannerProps) {
  const [changes, setChanges] = useState<Array<UpstreamChange>>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    loadChanges()
  }, [designId])

  const loadChanges = async () => {
    setLoading(true)
    setError(null)

    try {
      const response = await fetch(`/api/v1/mbom/${designId}/upstream-changes`)
      if (!response.ok) {
        throw new Error('Failed to load upstream changes')
      }

      const { data } = await response.json()
      setChanges(data.changes || [])
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  // Don't show anything if loading or no changes
  if (loading) {
    return null
  }

  if (error) {
    return null // Silently fail - not critical
  }

  if (changes.length === 0) {
    return null
  }

  // Count total changed items
  const totalChangedItems = changes.reduce(
    (sum, change) => sum + change.changedItems.length,
    0,
  )

  return (
    <div className="mb-6 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg">
      {/* Header */}
      <div className="px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
          <div>
            <h3 className="font-medium text-amber-800 dark:text-amber-200">
              Upstream Engineering Changes Detected
            </h3>
            <p className="text-sm text-amber-700 dark:text-amber-300">
              {totalChangedItems} item{totalChangedItems !== 1 ? 's' : ''}{' '}
              changed in {changes.length} source design
              {changes.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            className="border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4 mr-1" />
            ) : (
              <ChevronRight className="h-4 w-4 mr-1" />
            )}
            {expanded ? 'Hide Details' : 'Review Changes'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={loadChanges}
            className="border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Expanded Details */}
      {expanded && (
        <div className="border-t border-amber-200 dark:border-amber-800 px-4 py-3 space-y-4">
          {changes.map((change) => (
            <div key={change.id} className="space-y-2">
              {/* Source Design Info */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {change.sourceDesignCode}
                  </span>
                  <span className="text-sm text-slate-500 dark:text-slate-400">
                    {change.sourceDesignName}
                  </span>
                  {change.sourceEcoNumber && (
                    <span className="text-xs bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 px-2 py-0.5 rounded">
                      via {change.sourceEcoNumber}
                    </span>
                  )}
                </div>
                <Link
                  to="/designs/$id"
                  params={{ id: change.sourceDesignId }}
                  className="text-sm text-cyan-600 dark:text-cyan-400 hover:underline flex items-center gap-1"
                >
                  View Source <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              {/* Changed Items Table */}
              <div className="bg-white dark:bg-slate-900 rounded border border-amber-200 dark:border-amber-800 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 dark:bg-slate-800">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Item Number
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Name
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Type
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Change
                      </th>
                      <th className="px-3 py-2 text-left font-medium text-slate-600 dark:text-slate-400">
                        Revision
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                    {change.changedItems.map((item) => (
                      <tr key={item.masterId}>
                        <td className="px-3 py-2 font-medium text-slate-900 dark:text-slate-100">
                          {item.itemNumber}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                          {item.name || '-'}
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                          {item.itemType}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`
                              px-2 py-0.5 rounded text-xs font-medium
                              ${
                                item.changeType === 'added'
                                  ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
                                  : item.changeType === 'deleted'
                                    ? 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
                                    : 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300'
                              }
                            `}
                          >
                            {item.changeType}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-600 dark:text-slate-400">
                          {item.previousRevision} → {item.newRevision}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2 border-t border-amber-200 dark:border-amber-800">
            <p className="text-sm text-amber-700 dark:text-amber-300">
              Review these changes and decide whether to update the MBOM.
            </p>
            <div className="ml-auto flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-amber-300 dark:border-amber-700"
              >
                Dismiss All
              </Button>
              <Button size="sm">Create MCO to Update</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
