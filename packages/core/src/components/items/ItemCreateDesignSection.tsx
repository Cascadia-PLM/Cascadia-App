// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Info } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import type { Design } from '@/lib/types/design'
import { DesignPhaseIndicator } from '@/components/versioning/DesignPhaseIndicator'
import { BranchSelector } from '@/components/versioning/BranchSelector'
import { ViewEditSelect } from '@/components/ui'
import { designStatusQuery } from '@/lib/query'

interface ItemCreateDesignSectionProps {
  designs: Array<Design>
  designId: string | undefined
  displayedDesignId: string | undefined
  onDesignChange: (designId: string) => void
  isEditing: boolean
  isCreateMode: boolean
  selectedBranchId: string | undefined
  onBranchChange: (branchId: string | undefined) => void
  itemLabel: string
}

/**
 * Shared destination selector for versioned item creation. A released design
 * is protected from writes to main, so new items must target an ECO or
 * workspace branch.
 */
export function ItemCreateDesignSection({
  designs,
  designId,
  displayedDesignId,
  onDesignChange,
  isEditing,
  isCreateMode,
  selectedBranchId,
  onBranchChange,
  itemLabel,
}: ItemCreateDesignSectionProps) {
  const { data: designStatus = null, isFetching: loadingStatus } = useQuery(
    designStatusQuery(designId ?? '', isCreateMode && Boolean(designId)),
  )

  const branchRequired = designStatus?.protection.phase === 'post-release'
  const showBranchSelector = isCreateMode && Boolean(designId)
  const designOptions = [...designs]
    .sort((a, b) => {
      const libraryOrder =
        Number(a.designType === 'Library') - Number(b.designType === 'Library')
      return libraryOrder || (a.code || '').localeCompare(b.code || '')
    })
    .map((design) => ({
      value: design.id,
      label: `${design.code} - ${design.name}`,
    }))

  return (
    <div className="md:col-span-2 space-y-4">
      <div className="flex items-center gap-4">
        <ViewEditSelect
          label="Design"
          value={isEditing ? designId : displayedDesignId}
          onChange={onDesignChange}
          isEditing={isEditing && isCreateMode}
          options={designOptions}
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
                This design is under change control. New {itemLabel} must be
                created on an ECO or workspace branch.
              </span>
            </div>
          )}
          {!branchRequired && !selectedBranchId && (
            <div className="flex items-start gap-2 mt-2 p-3 bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-400 text-sm rounded-md">
              <Info className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <span>
                No branch selected - {itemLabel} will be created on the main
                branch. Select a workspace branch for private development work.
              </span>
            </div>
          )}
          {branchRequired && !selectedBranchId && (
            <p className="text-sm text-red-500">
              Please select a branch to create this {itemLabel} on
            </p>
          )}
        </div>
      )}
    </div>
  )
}
