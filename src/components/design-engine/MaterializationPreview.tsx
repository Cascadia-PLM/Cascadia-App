/**
 * MaterializationPreview - States exactly what materialization will do
 * (driven by the MaterializationPlan) before the user confirms execution.
 */

import { useState } from 'react'
import {
  AlertTriangle,
  FileText,
  GitBranch,
  Link,
  ListChecks,
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

/** Plain-language description of what executing the plan will do */
function planSummary(preview: PreviewType): Array<string> {
  const { plan } = preview
  const programLabel = plan.programName
    ? `program "${plan.programName}"`
    : 'the session program'

  if (plan.mode === 'create_design') {
    return [
      `A new design "${plan.newDesignName ?? 'Collaborative Design'}" will be created in ${programLabel}.`,
      `${preview.newRequirementsCount} requirements and ${preview.newPartsCount} new parts will be created in the "${plan.initialState}" state on the design's ${plan.targetBranch} branch.`,
      `${preview.bomRelationshipsCount} BOM relationships will link the parts into the assembly structure.`,
      'No ECO is needed — the design has no released items yet. Revision letters are assigned later, when the design is first released through an ECO.',
    ]
  }

  if (plan.mode === 'eco_required') {
    return [
      `Design "${plan.targetDesignName ?? 'design'}" has released items, so a new change order (${plan.ecoName ?? 'ECO'}) will be created in ${programLabel}.`,
      `${preview.newRequirementsCount} requirements and ${preview.newPartsCount} new parts will be added to the ECO's branch in the "${plan.initialState}" state.`,
      `${preview.bomRelationshipsCount} BOM relationships will link the parts into the assembly structure.`,
      'The items are released with revision letters when the ECO is reviewed and approved.',
    ]
  }

  // add_to_design
  return [
    `Items will be added to the existing design "${plan.targetDesignName ?? 'design'}" in ${programLabel}.`,
    `${preview.newRequirementsCount} requirements and ${preview.newPartsCount} new parts will be created in the "${plan.initialState}" state on the design's ${plan.targetBranch} branch.`,
    `${preview.bomRelationshipsCount} BOM relationships will link the parts into the assembly structure.`,
    'No ECO is needed — this design has no released items yet. Revision letters are assigned later, when the design is first released through an ECO.',
  ]
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

  const blocked = !preview.plan.supported

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
        Materialization Preview
      </h3>

      {/* Blocked notice (e.g. target design requires an ECO) */}
      {blocked ? (
        <div className="flex items-start gap-2 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
          <GitBranch className="h-4 w-4 text-yellow-600 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
              Materialization not available
            </p>
            <p className="text-xs text-yellow-600 dark:text-yellow-500 mt-0.5">
              {preview.plan.blockedReason ??
                'This target design cannot be materialized into.'}
            </p>
          </div>
        </div>
      ) : (
        /* What will happen */
        <div className="bg-cyan-50 dark:bg-cyan-900/20 border border-cyan-200 dark:border-cyan-800 rounded-lg p-3 space-y-1.5">
          <div className="flex items-center gap-2">
            <ListChecks className="h-4 w-4 text-cyan-600" />
            <p className="text-sm font-medium text-cyan-800 dark:text-cyan-300">
              What will happen
            </p>
          </div>
          <ul className="text-xs text-cyan-700 dark:text-cyan-400 space-y-1 list-disc pl-5">
            {planSummary(preview).map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}

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
      {!blocked && (
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
                  {preview.plan.mode === 'create_design'
                    ? `This will create the design "${preview.plan.newDesignName ?? 'Collaborative Design'}" plus `
                    : preview.plan.mode === 'eco_required'
                      ? `This will create a change order (${preview.plan.ecoName ?? 'ECO'}) and add `
                      : `This will add to design "${preview.plan.targetDesignName ?? 'design'}": `}
                  {preview.newPartsCount} new parts,{' '}
                  {preview.newRequirementsCount} requirements, and{' '}
                  {preview.bomRelationshipsCount} BOM relationships
                  {preview.plan.mode === 'eco_required'
                    ? ` to the ECO's branch — released with revision letters once the ECO is approved.`
                    : ` — all in the "${preview.plan.initialState}" state on the ${preview.plan.targetBranch} branch.`}
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
      )}
    </div>
  )
}
