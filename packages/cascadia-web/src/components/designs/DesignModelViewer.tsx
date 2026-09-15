// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Box } from 'lucide-react'
import type { ReactNode } from 'react'
import type { BOMTreeNode, OrphanItem } from '@/lib/types/bom'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import { CADFileSelect } from '@/components/parts/CADFileSelect'
import { CADViewerSurface } from '@/components/parts/CADViewerSurface'
import { useCADViewerState } from '@/components/parts/useCADViewerState'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { designStructureQuery } from '@/lib/query'

// Module scope so the "no structure yet" render keeps a stable array identity
// for the memo below.
const NO_ROOTS: Array<BOMTreeNode> = []

interface DesignModelViewerProps {
  designId: string
  /** Which version of the structure to read — the design page's selector. */
  versionContext: VersionContext
  /** The design's default branch, so inherited CAD documents resolve. */
  mainBranchId?: string
  /**
   * Render nothing when the design has no top-level part to pick between.
   * The design page wants that — its structure tab already says the design is
   * empty. The program page does not: hiding the card would take its design
   * picker with it, leaving no way to reach a design that does have models.
   */
  hideWhenEmpty?: boolean
  /** Prefixes the description. The program viewer names the design here. */
  scopeLabel?: string
  /** Controls rendered before the part picker — the program's design picker. */
  headerControls?: ReactNode
}

/**
 * The 3D model of one top-level part of a design, with a picker for the rest.
 *
 * Reads the same `designStructureQuery` the structure tab does, so mounting it
 * beneath that tab costs no second request; on the program page, where nothing
 * else has asked for the structure, it is the only reader.
 *
 * The selected part is derived rather than synchronised in an effect: state
 * holds the user's pick and falls back to the first root whenever that pick is
 * no longer in the tree, which is what makes swapping the design underneath
 * this component (the program page's picker) a plain re-render.
 */
export function DesignModelViewer({
  designId,
  versionContext,
  mainBranchId,
  hideWhenEmpty = false,
  scopeLabel,
  headerControls,
}: DesignModelViewerProps) {
  const { handleError } = useErrorHandler()

  const { data: structure } = useQuery(
    designStructureQuery<BOMTreeNode, OrphanItem>(designId, {
      branchId: versionContext.branchId,
      tagId: versionContext.tagId,
      commitId: versionContext.commitId,
    }),
  )
  const roots = structure?.roots ?? NO_ROOTS
  const topLevelParts = useMemo(
    () => roots.filter((node) => node.itemType === 'Part'),
    [roots],
  )

  const [pickedPartId, setPickedPartId] = useState<string | null>(null)
  const selectedPart =
    topLevelParts.find((node) => node.itemId === pickedPartId) ??
    topLevelParts.at(0) ??
    null

  // A tag or commit context resolves through main; only a branch names one,
  // which is the same reading the part page's own viewer takes.
  const viewer = useCADViewerState({
    itemId: selectedPart?.itemId,
    branchId:
      versionContext.type === 'branch' ? versionContext.branchId : undefined,
    mainBranchId,
    enabled: Boolean(selectedPart),
  })
  const { selectedFile, files } = viewer

  // "EBOM-001 • TDJ-25-100 — Base Plate • base-plate.glb", minus whatever is
  // not there: the scope label only on the program page, the file only once a
  // model has been resolved.
  const description = [
    scopeLabel,
    selectedPart
      ? `${selectedPart.itemNumber}${
          selectedPart.name ? ` — ${selectedPart.name}` : ''
        }`
      : 'Top-level parts of this design',
    selectedFile?.fileName,
  ]
    .filter(Boolean)
    .join(' • ')

  if (topLevelParts.length === 0 && hideWhenEmpty) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Box className="h-5 w-5 text-slate-400" />
              <CardTitle>3D Model</CardTitle>
            </div>
            <CardDescription>{description}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {headerControls}
            {topLevelParts.length > 1 && selectedPart && (
              <Select
                value={selectedPart.itemId}
                onValueChange={setPickedPartId}
              >
                <SelectTrigger
                  className="w-[240px] h-8 text-xs"
                  aria-label="Top-level part"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {topLevelParts.map((node) => (
                    <SelectItem key={node.itemId} value={node.itemId}>
                      {node.itemNumber}
                      {node.name ? ` — ${node.name}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {files.length > 1 && selectedFile && (
              <CADFileSelect
                files={files}
                selectedId={selectedFile.id}
                onSelect={viewer.selectFile}
              />
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {selectedFile ? (
          <CADViewerSurface
            viewer={viewer}
            file={selectedFile}
            onError={handleError}
          />
        ) : (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <Box className="h-8 w-8 text-slate-300 dark:text-slate-600" />
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {selectedPart
                ? `No viewable 3D model is attached to ${selectedPart.itemNumber}.`
                : 'This design has no top-level parts to display.'}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
