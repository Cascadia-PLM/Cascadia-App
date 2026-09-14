// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useId } from 'react'
import { PackagePlus, Search } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * The steps of a dialog that opens on this choice. 'existing' is the
 * dialog's original body; 'create' is the in-place part form.
 */
export type AddPartStep = 'choose' | 'existing' | 'create'

interface AddPartChoiceProps {
  /** What "Create New" will do, in this dialog's terms. */
  createDescription: string
  /** What "Use Existing" will do. */
  existingDescription: string
  onCreateNew: () => void
  onUseExisting: () => void
}

/**
 * The choice an add-part dialog opens on: make a new part here, or bring in
 * one that exists. Shared by the design's Add Part and the tree's Add Child,
 * which differ only in what each choice then does.
 */
export function AddPartChoice({
  createDescription,
  existingDescription,
  onCreateNew,
  onUseExisting,
}: AddPartChoiceProps) {
  return (
    <div className="flex items-stretch gap-4 py-2">
      <ChoiceButton
        icon={<PackagePlus className="h-8 w-8" />}
        title="Create New"
        description={createDescription}
        onClick={onCreateNew}
        data-testid="add-part-create-new"
      />
      <div
        role="separator"
        aria-orientation="vertical"
        className="w-px self-stretch bg-slate-200 dark:bg-slate-700"
      />
      <ChoiceButton
        icon={<Search className="h-8 w-8" />}
        title="Use Existing"
        description={existingDescription}
        onClick={onUseExisting}
        data-testid="add-part-use-existing"
      />
    </div>
  )
}

function ChoiceButton({
  icon,
  title,
  description,
  onClick,
  'data-testid': testId,
}: {
  icon: ReactNode
  title: string
  description: string
  onClick: () => void
  'data-testid': string
}) {
  // The visible title is the accessible name; the description stays a
  // description, so a screen reader announces "Create New" and not the
  // whole paragraph.
  const titleId = useId()
  const descriptionId = useId()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid={testId}
      className="flex flex-1 flex-col items-center gap-2 rounded-lg border border-slate-200 dark:border-slate-700 px-4 py-6 text-center text-slate-600 dark:text-slate-400 transition-colors hover:border-cyan-400 hover:bg-cyan-50 hover:text-cyan-700 dark:hover:border-cyan-600 dark:hover:bg-cyan-950 dark:hover:text-cyan-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500"
    >
      {icon}
      <span
        id={titleId}
        className="font-medium text-slate-900 dark:text-slate-100"
      >
        {title}
      </span>
      <span id={descriptionId} className="text-sm">
        {description}
      </span>
    </button>
  )
}
