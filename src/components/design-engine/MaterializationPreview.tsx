/**
 * MaterializationPreview - Shows what will be created before executing
 */

import { useState } from 'react'
import {
  AlertTriangle,
  FileText,
  GitBranch,
  Link,
  Loader2,
  Package,
} from 'lucide-react'
import type { MaterializationPreview as PreviewType } from '@/lib/design-engine/types'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Card, CardContent } from '@/components/ui/Card'

interface MaterializationPreviewProps {
  preview: PreviewType | null
  isLoading: boolean
  onMaterialize: () => void
  isMaterializing: boolean
}

export function MaterializationPreview({
  preview,
  isLoading,
  onMaterialize,
  isMaterializing,
}: MaterializationPreviewProps) {
  const [confirmed, setConfirmed] = useState(false)

  if (isLoading || !preview) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        <span className="ml-2 text-sm text-slate-400">
          Generating preview...
        </span>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
        Materialization Preview
      </h3>

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <Package className="h-4 w-4 text-purple-500" />
            <div>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-200">
                {preview.newPartsCount}
              </p>
              <p className="text-xs text-slate-500">New Parts</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <Package className="h-4 w-4 text-cyan-500" />
            <div>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-200">
                {preview.reusedPartsCount}
              </p>
              <p className="text-xs text-slate-500">Reused Parts</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <FileText className="h-4 w-4 text-green-500" />
            <div>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-200">
                {preview.newRequirementsCount}
              </p>
              <p className="text-xs text-slate-500">Requirements</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-2">
            <Link className="h-4 w-4 text-yellow-500" />
            <div>
              <p className="text-lg font-bold text-slate-800 dark:text-slate-200">
                {preview.bomRelationshipsCount}
              </p>
              <p className="text-xs text-slate-500">BOM Relationships</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ECO notice */}
      {preview.requiresEco && (
        <div className="flex items-start gap-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
          <GitBranch className="h-4 w-4 text-yellow-600 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              ECO Required
            </p>
            <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-0.5">
              The target design has released items. An Engineering Change Order
              will be created automatically to manage this change.
            </p>
          </div>
        </div>
      )}

      {/* Items to create */}
      <div className="space-y-1">
        <h4 className="text-xs font-semibold text-slate-600 dark:text-slate-400">
          Items
        </h4>
        <div className="border border-slate-200 dark:border-slate-700 rounded-lg divide-y divide-slate-100 dark:divide-slate-800">
          {preview.items.map((item) => (
            <div
              key={item.tempId}
              className="px-3 py-2 flex items-center gap-2 text-sm"
            >
              <span className="flex-1 truncate text-slate-700 dark:text-slate-300">
                {item.name}
              </span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                {item.itemType}
              </Badge>
              {item.isNew ? (
                <Badge
                  variant="default"
                  className="text-[10px] px-1.5 py-0 bg-purple-500"
                >
                  NEW
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
                  {item.existingItemNumber}
                </Badge>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Materialize button */}
      <div className="space-y-2">
        {!confirmed ? (
          <Button
            variant="default"
            onClick={() => setConfirmed(true)}
            className="w-full"
          >
            Review & Materialize
          </Button>
        ) : (
          <div className="space-y-2">
            <div className="flex items-start gap-2 bg-slate-50 dark:bg-slate-800 rounded-lg p-3">
              <AlertTriangle className="h-4 w-4 text-yellow-500 mt-0.5" />
              <p className="text-xs text-slate-600 dark:text-slate-400">
                This will create {preview.newPartsCount} new parts,{' '}
                {preview.newRequirementsCount} requirements, and{' '}
                {preview.bomRelationshipsCount} BOM relationships in the
                database.
                {preview.requiresEco &&
                  ' An ECO will be created for change management.'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button
                variant="default"
                onClick={onMaterialize}
                disabled={isMaterializing}
                className="flex-1"
              >
                {isMaterializing ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Confirm & Create'
                )}
              </Button>
              <Button
                variant="outline"
                onClick={() => setConfirmed(false)}
                disabled={isMaterializing}
              >
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
