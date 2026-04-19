/**
 * MaterializationResult - Success state after materialization
 */

import { CheckCircle, ExternalLink, Plus } from 'lucide-react'
import type { MaterializationResult as ResultType } from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'

interface MaterializationResultProps {
  result: ResultType
  onNavigate: (url: string) => void
  onStartNew: () => void
}

export function MaterializationResult({
  result,
  onNavigate,
  onStartNew,
}: MaterializationResultProps) {
  return (
    <div className="space-y-4">
      {/* Success header */}
      <div className="flex items-center gap-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
        <CheckCircle className="h-6 w-6 text-green-500 flex-shrink-0" />
        <div>
          <h3 className="text-sm font-semibold text-green-800 dark:text-green-300">
            Design Materialized Successfully
          </h3>
          <p className="text-xs text-green-600 dark:text-green-400 mt-0.5">
            Created {result.createdItems.length} items and{' '}
            {result.bomRelationshipsCreated} BOM relationships
          </p>
        </div>
      </div>

      {/* Quick links */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onNavigate(`/designs/${result.designId}`)}
          className="text-xs gap-1.5"
        >
          <ExternalLink className="h-3 w-3" />
          View Design
        </Button>
        {result.ecoId && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onNavigate(`/change-orders/${result.ecoId}`)}
            className="text-xs gap-1.5"
          >
            <ExternalLink className="h-3 w-3" />
            View ECO {result.ecoNumber}
          </Button>
        )}
      </div>

      {/* Created items */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-400">
          Created Items
        </h4>
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
          {result.createdItems.map((item) => (
            <div
              key={item.itemId}
              className="px-3 py-2 flex items-center gap-2 text-sm cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800"
              onClick={() => {
                const route =
                  item.itemType === 'Part'
                    ? `/parts/${item.itemId}`
                    : item.itemType === 'Requirement'
                      ? `/requirements/${item.itemId}`
                      : `/items/${item.itemId}`
                onNavigate(route)
              }}
            >
              <span className="flex-1 truncate text-slate-700 dark:text-slate-300">
                {item.name}
              </span>
              <span className="text-xs font-mono text-slate-400">
                {item.itemNumber}
              </span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {item.itemType}
              </Badge>
              <ExternalLink className="h-3 w-3 text-slate-400" />
            </div>
          ))}
        </div>
      </div>

      {/* Start new */}
      <Button variant="outline" onClick={onStartNew} className="w-full gap-2">
        <Plus className="h-4 w-4" />
        Start New Design Session
      </Button>
    </div>
  )
}
