// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Design } from '@/lib/types/design'
import { ItemCreateDesignSection } from '@/components/items/ItemCreateDesignSection'

/**
 * Backwards-compatible part-specific wrapper. New versioned item create flows
 * should use ItemCreateDesignSection directly.
 */
export function PartCreateSection(props: {
  designs: Array<Design>
  designId: string | undefined
  displayedDesignId: string | undefined
  onDesignChange: (designId: string) => void
  isEditing: boolean
  isCreateMode: boolean
  selectedBranchId: string | undefined
  onBranchChange: (branchId: string | undefined) => void
}) {
  return <ItemCreateDesignSection {...props} itemLabel="part" />
}
