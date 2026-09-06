// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Part } from '@/lib/items/types/part'
import { DigitalThreadNavigator } from '@/components/thread'
import { PartRelationshipsPanel } from '@/components/items/PartRelationshipsPanel'
import { RequirementLinkingPanel } from '@/components/requirements/RequirementLinkingPanel'
import { PartValidationPanel } from '@/components/parts/PartValidationPanel'
import { Card, CardContent } from '@/components/ui'

/**
 * The Relationships tab of the part page: digital thread, the relationships
 * panel, requirement links, validation. Extracted from `PartDetail` — it is
 * independent of the page's edit state except for the one flag it takes.
 *
 * Structure edits follow the click-Edit policy: read-only until the user
 * enters edit mode, which holds the server-side checkout lock.
 */
export function PartRelationshipsTab({
  part,
  branchId,
  isEditing,
}: {
  part: Part
  branchId?: string
  isEditing: boolean
}) {
  if (!part.id) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-slate-500 dark:text-slate-400">
            Save the part first to manage relationships
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <DigitalThreadNavigator
        itemId={part.id}
        itemNumber={part.itemNumber}
        itemName={part.name}
        designId={part.designId}
      />
      <PartRelationshipsPanel
        itemId={part.id}
        itemType="Part"
        branchId={branchId}
        readOnly={!isEditing}
      />
      <RequirementLinkingPanel
        itemId={part.id}
        designId={part.designId}
        readOnly={!isEditing}
      />
      <PartValidationPanel
        partId={part.id}
        designId={part.designId}
        isEditable={isEditing}
      />
    </>
  )
}
