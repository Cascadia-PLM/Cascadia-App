// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { CADFileEntry } from './cad-types'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

/**
 * Picks which of an item's viewable models the viewer draws: direct files
 * first, then one group per CAD document they were inherited from.
 *
 * Lived inside `PartCADSection` until the design and program pages grew
 * viewers of their own — the grouping is a property of how `/cad-files`
 * answers, not of the part page.
 */
export function CADFileSelect({
  files,
  selectedId,
  onSelect,
}: {
  files: Array<CADFileEntry>
  selectedId: string
  onSelect: (file: CADFileEntry) => void
}) {
  const direct = files.filter((f) => f.source === 'direct')
  const docGroups = new Map<string, Array<CADFileEntry>>()
  for (const f of files.filter((cf) => cf.source === 'cad_doc')) {
    const key = f.sourceItemNumber ?? f.sourceItemId
    const group = docGroups.get(key)
    if (group) group.push(f)
    else docGroups.set(key, [f])
  }

  return (
    <Select
      value={selectedId}
      onValueChange={(fileId) => {
        const file = files.find((f) => f.id === fileId)
        if (file) onSelect(file)
      }}
    >
      <SelectTrigger className="w-[220px] h-8 text-xs" aria-label="CAD file">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {direct.length > 0 && (
          <SelectGroup>
            <SelectLabel>Direct Files</SelectLabel>
            {direct.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.fileName}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {Array.from(docGroups.entries()).map(([label, groupFiles]) => (
          <SelectGroup key={label}>
            <SelectLabel>{label}</SelectLabel>
            {groupFiles.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.fileName}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
