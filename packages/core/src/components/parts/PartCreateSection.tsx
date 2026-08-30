// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Info } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Design } from '@/lib/types/design'
import { DesignPhaseIndicator } from '@/components/versioning/DesignPhaseIndicator'
import { BranchSelector } from '@/components/versioning/BranchSelector'
import { ViewEditSelect } from '@/components/ui'
import { designStatusQuery } from '@/lib/query'

/**
 * Where a new part is going: which design, and — once the design is under
 * change control — which branch.
 *
 * Rendered inside the Overview card's `<dl>`, which is why it returns a
 * fragment-shaped `<div>` rather than a Card of its own. It also shows for an
 * existing part that somehow has no design, which is the second half of the
 * condition its caller applies.
 *
 * Reads the design-status query directly rather than taking it as a prop.
 * PartDetail asks the same question to gate its submit button, and the shared
 * key means the two reads are one request — the idiom FileList and
 * ImageGallery already use for a part's files.
 */
export function PartCreateSection({
  designs,
  designId,
  displayedDesignId,
  onDesignChange,
  isEditing,
  isCreateMode,
  selectedBranchId,
  onBranchChange,
}: {
  designs: Array<Design>
  /** The design being edited (create mode) — drives the status query. */
  designId: string | undefined
  /** What to show when not editing: the part's own design. */
  displayedDesignId: string | undefined
  onDesignChange: (designId: string) => void
  isEditing: boolean
  isCreateMode: boolean
  selectedBranchId: string | undefined
  onBranchChange: (branchId: string | undefined) => void
}) {
  const { data: designStatus = null, isFetching: loadingStatus } = useQuery(
    designStatusQuery(designId ?? '', isCreateMode && Boolean(designId)),
  )

  // A design under change control cannot take new parts on main.
  const branchRequired = designStatus?.protection.phase === 'post-release'
  const showBranchSelector = isCreateMode && Boolean(designId)

  return (
    <div className="md:col-span-2 space-y-4">
      <div className="flex items-center gap-4">
        <ViewEditSelect
          label="Design"
          value={isEditing ? designId : displayedDesignId}
          onChange={onDesignChange}
          isEditing={isEditing && isCreateMode}
          options={designs.map((d) => ({
            value: d.id,
            label: `${d.code} - ${d.name}`,
          }))}
          placeholder="Select a design..."
          required
          data-testid="design-selector"
        />
        {designId && !loadingStatus && designStatus && (
          <DesignPhaseIndicator designId={designId} status={designStatus} />
        )}
      </div>

      {showBranchSelector && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Target Branch{' '}
            {branchRequired && <span className="text-red-500">*</span>}
          </label>
          <BranchSelector
            designId={designId ?? ''}
            value={selectedBranchId}
            onChange={onBranchChange}
            showMainOption={!branchRequired}
            placeholder={
              branchRequired ? 'Select branch...' : 'Main branch (default)'
            }
          />
          {branchRequired && (
            <div className="flex items-start gap-2 mt-2 p-3 bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-sm rounded-md">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                This design is under change control. New parts must be created
                on an ECO or workspace branch.
              </span>
            </div>
          )}
          {!branchRequired && !selectedBranchId && (
            <div className="flex items-start gap-2 mt-2 p-3 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400 text-sm rounded-md">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                No branch selected - part will be created on the main branch.
                Select a workspace branch for private development work.
              </span>
            </div>
          )}
          {branchRequired && !selectedBranchId && (
            <p className="text-sm text-red-500">
              Please select a branch to create this part on
            </p>
          )}
        </div>
      )}
    </div>
  )
}
