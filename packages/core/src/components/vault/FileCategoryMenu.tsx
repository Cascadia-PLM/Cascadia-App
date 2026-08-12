// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { RotateCcw, Tag } from 'lucide-react'
import type { FileCategory } from '@/lib/vault/file-categories'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { Button } from '@/components/ui/Button'
import {
  FILE_CATEGORY_OPTIONS,
  isFileCategory,
} from '@/lib/vault/file-categories'

export interface FileCategoryMenuProps {
  /** The file's current category, as stored */
  category: string | null | undefined
  /** 'manual' once a person has set the category; 'auto' while detected */
  categorySource: string | null | undefined
  /** Called with a category to override, or null to return to auto-detection */
  onChange: (category: FileCategory | null) => void
  disabled?: boolean
}

/**
 * Picker for correcting a file's category.
 *
 * Detection is only a guess from the filename — a PDF may be a spec, a
 * certificate, or a drawing — so every file's category is correctable, and the
 * menu says whether the current value was detected or chosen by someone.
 */
export function FileCategoryMenu({
  category,
  categorySource,
  onChange,
  disabled,
}: FileCategoryMenuProps) {
  const isManual = categorySource === 'manual'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          disabled={disabled}
          title="Change category"
        >
          <Tag className="w-4 h-4" />
          <span className="sr-only">Change category</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          Category
          <span className="ml-2 font-normal text-xs text-slate-500 dark:text-slate-400">
            {isManual ? 'set manually' : 'auto-detected'}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup
          value={isFileCategory(category) ? category : ''}
          onValueChange={(value) => {
            if (isFileCategory(value)) onChange(value)
          }}
        >
          {FILE_CATEGORY_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {isManual && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => onChange(null)}>
              <RotateCcw className="mr-2 h-4 w-4" />
              Reset to auto-detected
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
