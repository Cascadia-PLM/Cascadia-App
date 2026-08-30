// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type {
  CADCompareLayer,
  CADCompareSlot,
} from '@/components/parts/CADViewer'
import type { CompareSlotSelection } from '@/components/parts/CADComparePanel'
import type { ModelVersionEntry } from '@/lib/query'
import {
  COMPARE_SLOT_COLORS,
  DEFAULT_COMPARE_OPACITY,
} from '@/components/parts/CADViewer'
import {
  modelVersionLabel,
  resolveSlot,
} from '@/components/parts/CADComparePanel'
import { itemModelVersionsQuery } from '@/lib/query'

/** A side of the comparison with nothing picked yet, in its own tint. */
export function emptyCompareSlot(slot: CADCompareSlot): CompareSlotSelection {
  return {
    versionKey: null,
    fileId: null,
    color: COMPARE_SLOT_COLORS[slot],
    opacity: DEFAULT_COMPARE_OPACITY,
    visible: true,
  }
}

/**
 * The version entry matching the context the page is displaying.
 *
 * Matching on the item row is what makes this exact: a branch working copy
 * and its released counterpart are different rows, so the row the page
 * resolved to names the entry unambiguously. The branch fallback covers the
 * case where a branch has not minted a working copy yet, and both entries
 * therefore point at the released row.
 */
function versionEntryForContext(
  versions: Array<ModelVersionEntry>,
  itemId: string | undefined,
  branchId: string | null,
): ModelVersionEntry | null {
  const withModels = versions.filter((v) => v.files.length > 0)
  const onBranch = branchId
    ? withModels.find((v) => v.branch?.id === branchId)
    : undefined
  return (
    onBranch ??
    withModels.find((v) => v.itemId === itemId) ??
    withModels.find((v) => v.kind === 'current') ??
    withModels.at(0) ??
    null
  )
}

/**
 * The version worth showing opposite `against` by default: what a change is
 * normally measured against. From an in-work branch that is the released
 * revision it will supersede; from a released one it is whatever work is in
 * flight, then the revision before it.
 */
function defaultCounterpart(
  versions: Array<ModelVersionEntry>,
  against: ModelVersionEntry,
): ModelVersionEntry | null {
  const candidates = versions.filter(
    (v) =>
      v.key !== against.key &&
      v.files.length > 0 &&
      v.files.at(0)?.id !== against.files.at(0)?.id,
  )
  const order: Array<ModelVersionEntry['kind']> =
    against.kind === 'branch'
      ? ['current', 'historical', 'branch']
      : ['branch', 'historical', 'current']

  for (const kind of order) {
    const match = candidates.find((v) => v.kind === kind)
    if (match) return match
  }
  return null
}

export interface CADCompareState {
  isOpen: boolean
  open: () => void
  close: () => void
  versions: Array<ModelVersionEntry>
  isLoading: boolean
  a: CompareSlotSelection
  b: CompareSlotSelection
  onChange: (slot: CADCompareSlot, next: CompareSlotSelection) => void
  onSwap: () => void
  /**
   * What the viewer renders, or null while neither side has resolved to a
   * real model — so opening the panel never blanks the canvas mid-load.
   */
  comparison: { a: CADCompareLayer | null; b: CADCompareLayer | null } | null
}

/**
 * The two-version comparison behind the CAD viewer: which versions, which
 * files, and the layers the viewer draws.
 *
 * Separate from `useCADViewerState` because the two answer different
 * questions — that one owns "what am I looking at", this one owns "against
 * what" — and because the comparison is only ever fetched while the panel is
 * open, which is a different lifetime from the file list.
 */
export function useCADCompareState({
  itemId,
  branchId,
  enabled,
  selectedFileId,
}: {
  itemId: string | undefined
  branchId: string | null
  /** False in create mode, where there are no versions to compare. */
  enabled: boolean
  /** Seeds side A with the file the viewer is already showing. */
  selectedFileId: string | null
}): CADCompareState {
  const [isOpen, setIsOpen] = useState(false)
  const [a, setA] = useState<CompareSlotSelection>(() => emptyCompareSlot('A'))
  const [b, setB] = useState<CompareSlotSelection>(() => emptyCompareSlot('B'))

  // Master-scoped, so every entry stays valid as the user moves between
  // version contexts of the same part. Only fetched while the panel is open.
  const { data: versions = [], isLoading } = useQuery(
    itemModelVersionsQuery(enabled ? itemId : undefined, isOpen),
  )

  // Landing on a different version row re-seeds the comparison from scratch.
  useEffect(() => {
    setA(emptyCompareSlot('A'))
    setB(emptyCompareSlot('B'))
  }, [itemId])

  // Seed side A from what the page is already showing and side B from the
  // most useful other version, so opening the panel is a comparison right
  // away rather than two empty pickers. Only ever fills a side the user has
  // not chosen, so re-renders never fight their selection.
  useEffect(() => {
    if (!isOpen || a.versionKey !== null) return

    const entryA = versionEntryForContext(versions, itemId, branchId)
    const fileA =
      entryA?.files.find((f) => f.id === selectedFileId) ?? entryA?.files.at(0)
    if (!entryA || !fileA) return

    setA({ ...emptyCompareSlot('A'), versionKey: entryA.key, fileId: fileA.id })

    const entryB = defaultCounterpart(versions, entryA)
    const fileB = entryB?.files.at(0)
    if (entryB && fileB) {
      setB({
        ...emptyCompareSlot('B'),
        versionKey: entryB.key,
        fileId: fileB.id,
      })
    }
  }, [isOpen, a.versionKey, versions, itemId, branchId, selectedFileId])

  const layer = (selection: CompareSlotSelection): CADCompareLayer | null => {
    const { entry, file } = resolveSlot(versions, selection)
    if (!entry || !file) return null
    return {
      fileId: file.id,
      fileUrl: `/api/v1/files/${file.id}/download`,
      fileType: file.fileType,
      fileName: file.fileName,
      versionLabel: modelVersionLabel(entry),
      color: selection.color,
      opacity: selection.opacity,
      visible: selection.visible,
    }
  }

  const layerA = isOpen ? layer(a) : null
  const layerB = isOpen ? layer(b) : null

  return {
    isOpen,
    open: () => {
      setIsOpen(true)
    },
    close: () => {
      setIsOpen(false)
      setA(emptyCompareSlot('A'))
      setB(emptyCompareSlot('B'))
    },
    versions,
    isLoading,
    a,
    b,
    onChange: (slot, next) => {
      if (slot === 'A') setA(next)
      else setB(next)
    },
    onSwap: () => {
      // Colors belong to the side, not to the model: swapping moves the
      // versions and leaves A and B their own tints, so the legend holds
      // still.
      const previousA = a
      const previousB = b
      setA({ ...previousB, color: previousA.color })
      setB({ ...previousA, color: previousB.color })
    },
    comparison: (layerA ?? layerB) ? { a: layerA, b: layerB } : null,
  }
}
