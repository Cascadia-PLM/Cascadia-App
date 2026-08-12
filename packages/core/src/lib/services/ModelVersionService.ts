// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { branchItems, branches, items, vaultFiles } from '../db/schema'
import { RevisionService } from './RevisionService'
import { VersionResolver } from './VersionResolver'
import { DesignService } from './DesignService'

/**
 * Enumerates every version of an item's master that the 3D comparison view
 * can offer as an overlay target, each resolved to the viewable CAD model
 * that version context would show.
 *
 * Three kinds of entries:
 * - `current`    — the released version on main (one entry, when it exists)
 * - `branch`     — the working version on each active ECO/workspace/release
 *                  branch that tracks this master
 * - `historical` — every previously released revision row of the master
 *
 * File resolution mirrors the viewer's own rules (`/items/:id/cad-files` +
 * the client's pick priority): viewable extensions only, category
 * `cad_model`, GLB-with-colors preferred, then the primary model, then the
 * newest upload. Files attach to a specific item *version* row and carry a
 * branch-visibility column, so:
 * - current/historical entries only see files attached to their own row that
 *   are visible outside a work branch (branchId null or main),
 * - branch entries additionally see that branch's own uploads — which may
 *   hang off the working copy row *or* the base row, depending on whether
 *   the upload happened before or after the working copy was minted — and
 *   prefer them over the inherited baseline model.
 */
export class ModelVersionService {
  /**
   * Extensions the 3D viewer can render. Must stay in sync with
   * VIEWABLE_CAD_EXTENSIONS in `src/server/routes/items.ts` (cad-files).
   */
  private static readonly VIEWABLE_EXTENSIONS = new Set([
    'stl',
    'obj',
    'glb',
    'gltf',
  ])

  static async listForItem(
    item: typeof items.$inferSelect,
  ): Promise<Array<ModelVersionEntry>> {
    const { masterId, designId } = item

    const mainBranch = designId
      ? await DesignService.getDefaultBranch(designId)
      : null

    // The version main resolves to right now. Absent for items that only
    // exist as unreleased branch drafts (first release still pending).
    const currentRow = designId
      ? await VersionResolver.getReleasedVersion(masterId, designId)
      : item

    // Every version row of this master in this design, released or not.
    const designCondition = designId
      ? eq(items.designId, designId)
      : isNull(items.designId)
    const masterRows = await db
      .select()
      .from(items)
      .where(and(eq(items.masterId, masterId), designCondition))

    const historicalRows = masterRows
      .filter(
        (row) =>
          !RevisionService.isWorkingRevision(row.revision) &&
          row.id !== currentRow?.id &&
          row.isDeleted !== true,
      )
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime())

    // Active work branches tracking this master. Main is excluded by branch
    // type; archived branches (released/cancelled ECOs) are history, not
    // in-work versions.
    const branchRows = designId
      ? await db
          .select({ branch: branches, branchItem: branchItems })
          .from(branchItems)
          .innerJoin(branches, eq(branchItems.branchId, branches.id))
          .where(
            and(
              eq(branchItems.itemMasterId, masterId),
              eq(branches.designId, designId),
              eq(branches.isArchived, false),
              inArray(branches.branchType, ['eco', 'workspace', 'release']),
            ),
          )
      : []
    const activeBranches = branchRows.filter(
      ({ branchItem }) => branchItem.changeType !== 'deleted',
    )

    // ECO numbers for branches owned by a change order, in one lookup.
    const changeOrderItemIds = [
      ...new Set(
        activeBranches
          .map(({ branch }) => branch.changeOrderItemId)
          .filter((id): id is string => Boolean(id)),
      ),
    ]
    const changeOrderNumbers = new Map<string, string>(
      changeOrderItemIds.length > 0
        ? (
            await db
              .select({ id: items.id, itemNumber: items.itemNumber })
              .from(items)
              .where(inArray(items.id, changeOrderItemIds))
          ).map((row) => [row.id, row.itemNumber])
        : [],
    )

    // All candidate files in one query: every row any entry can draw from.
    const candidateRowIds = new Set<string>()
    if (currentRow) candidateRowIds.add(currentRow.id)
    for (const row of historicalRows) candidateRowIds.add(row.id)
    for (const { branchItem } of activeBranches) {
      if (branchItem.currentItemId)
        candidateRowIds.add(branchItem.currentItemId)
      if (branchItem.baseItemId) candidateRowIds.add(branchItem.baseItemId)
    }

    const files =
      candidateRowIds.size > 0
        ? await db
            .select()
            .from(vaultFiles)
            .where(
              and(
                inArray(vaultFiles.itemId, [...candidateRowIds]),
                isNull(vaultFiles.deletedAt),
                eq(vaultFiles.fileCategory, 'cad_model'),
                eq(vaultFiles.isLatestVersion, true),
              ),
            )
            .orderBy(desc(vaultFiles.uploadedAt))
        : []
    const viewableFiles = files.filter((f) =>
      this.isViewable(f.originalFileName),
    )

    const mainBranchId = mainBranch?.id ?? null

    // Visible outside work branches: unscoped (promoted/legacy) or on main.
    const mainVisible = (f: VaultFileRow) =>
      f.branchId === null || f.branchId === mainBranchId

    const entries: Array<ModelVersionEntry> = []

    if (currentRow) {
      entries.push({
        key: 'current',
        kind: 'current',
        itemId: currentRow.id,
        revision: currentRow.revision,
        state: currentRow.state,
        modifiedAt: currentRow.modifiedAt,
        branch: null,
        file: this.pickModel(
          viewableFiles.filter(
            (f) => f.itemId === currentRow.id && mainVisible(f),
          ),
        ),
      })
    }

    for (const { branch, branchItem } of activeBranches) {
      const workingRow = branchItem.currentItemId
        ? masterRows.find((row) => row.id === branchItem.currentItemId)
        : undefined
      const versionRow = workingRow ?? currentRow
      if (!versionRow) continue

      const rowIds = new Set(
        [
          branchItem.currentItemId,
          branchItem.baseItemId,
          currentRow?.id,
        ].filter((id): id is string => Boolean(id)),
      )
      const visible = viewableFiles.filter(
        (f) =>
          rowIds.has(f.itemId) && (mainVisible(f) || f.branchId === branch.id),
      )
      // The branch's own uploads are its in-change model; the baseline is
      // only the answer when the branch hasn't touched the geometry.
      const branchOwn = visible.filter((f) => f.branchId === branch.id)
      const inherited = visible.filter((f) => f.branchId !== branch.id)

      entries.push({
        key: `branch:${branch.id}`,
        kind: 'branch',
        itemId: versionRow.id,
        revision: versionRow.revision,
        state: versionRow.state,
        modifiedAt: versionRow.modifiedAt,
        branch: {
          id: branch.id,
          name: branch.name,
          branchType: branch.branchType,
          changeOrderItemId: branch.changeOrderItemId,
          changeOrderNumber: branch.changeOrderItemId
            ? (changeOrderNumbers.get(branch.changeOrderItemId) ?? null)
            : null,
        },
        file: this.pickModel(branchOwn) ?? this.pickModel(inherited),
      })
    }

    for (const row of historicalRows) {
      entries.push({
        key: `historical:${row.id}`,
        kind: 'historical',
        itemId: row.id,
        revision: row.revision,
        state: row.state,
        modifiedAt: row.modifiedAt,
        branch: null,
        file: this.pickModel(
          viewableFiles.filter((f) => f.itemId === row.id && mainVisible(f)),
        ),
      })
    }

    return entries
  }

  private static isViewable(fileName: string): boolean {
    const ext = fileName.toLowerCase().split('.').pop()
    return ext !== undefined && this.VIEWABLE_EXTENSIONS.has(ext)
  }

  /**
   * The client's model pick priority: GLB with embedded colors, then the
   * designated primary model, then the newest upload (input is ordered
   * uploadedAt desc).
   */
  private static pickModel(
    files: Array<VaultFileRow>,
  ): ModelVersionFile | null {
    const glbWithColors = files.find(
      (f) => this.extension(f) === 'glb' && this.hasColors(f),
    )
    const primary = files.find((f) => f.isPrimaryModel)
    const chosen = glbWithColors ?? primary ?? files.at(0)
    if (!chosen) return null

    return {
      id: chosen.id,
      fileName: chosen.originalFileName,
      fileType: this.extension(chosen),
      hasColors: this.hasColors(chosen),
      fileSize: Number(chosen.fileSize),
      uploadedAt: chosen.uploadedAt,
    }
  }

  private static extension(file: VaultFileRow): string {
    return file.originalFileName.toLowerCase().split('.').pop() ?? ''
  }

  private static hasColors(file: VaultFileRow): boolean {
    return file.cadMetadata?.hasColors === true
  }
}

type VaultFileRow = typeof vaultFiles.$inferSelect

export interface ModelVersionFile {
  id: string
  fileName: string
  fileType: string
  hasColors: boolean
  fileSize: number
  uploadedAt: Date
}

export interface ModelVersionEntry {
  /** Stable identity for UI selection: `current`, `branch:<id>`, `historical:<itemId>`. */
  key: string
  kind: 'current' | 'branch' | 'historical'
  /** The item version row this entry resolves to. */
  itemId: string
  revision: string
  state: string
  modifiedAt: Date
  branch: {
    id: string
    name: string
    branchType: string
    changeOrderItemId: string | null
    changeOrderNumber: string | null
  } | null
  /** The model this version context would show, or null when it has none. */
  file: ModelVersionFile | null
}
