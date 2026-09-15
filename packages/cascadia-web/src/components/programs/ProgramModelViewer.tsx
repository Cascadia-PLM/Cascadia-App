// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo, useState } from 'react'
import type { Design } from '@/lib/types/design'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import { DesignModelViewer } from '@/components/designs/DesignModelViewer'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

// The program page has no version selector, so its viewer reads released
// state. Module scope keeps the object identity stable across renders.
const MAIN_CONTEXT: VersionContext = { type: 'main' }

/**
 * The 3D model of one top-level part of one design in a program.
 *
 * Two nested choices — which design, then which of its top-level parts — and
 * only the outer one belongs here: the design picker rides into
 * {@link DesignModelViewer} as a header control so both selects sit on the
 * same row and the part picker stays with the structure it reads.
 */
export function ProgramModelViewer({ designs }: { designs: Array<Design> }) {
  // Family designs are containers for other designs and hold no items of
  // their own, so there is never anything under one to draw.
  const candidates = useMemo(
    () => designs.filter((design) => design.designType !== 'Family'),
    [designs],
  )

  const [pickedDesignId, setPickedDesignId] = useState<string | null>(null)
  const selectedDesign =
    candidates.find((design) => design.id === pickedDesignId) ??
    candidates.at(0) ??
    null

  if (!selectedDesign) return null

  return (
    <DesignModelViewer
      designId={selectedDesign.id}
      versionContext={MAIN_CONTEXT}
      mainBranchId={selectedDesign.defaultBranchId ?? undefined}
      scopeLabel={selectedDesign.code}
      headerControls={
        candidates.length > 1 && (
          <Select value={selectedDesign.id} onValueChange={setPickedDesignId}>
            <SelectTrigger
              className="w-[220px] h-8 text-xs"
              aria-label="Design"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((design) => (
                <SelectItem key={design.id} value={design.id}>
                  {design.code} — {design.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }
    />
  )
}
