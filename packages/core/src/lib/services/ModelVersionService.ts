// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { and, desc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '../db'
import { branchItems, branches, items, vaultFiles } from '../db/schema'
import { RevisionService } from './RevisionService'
import { VersionResolver } from './VersionResolver'
import { DesignService } from './DesignService'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'

/**
 * Enumerates every version of an item's master that the 3D comparison view
 * can offer, each resolved to the viewable CAD models that version context
 * would show.
 *
 * Three kinds of entries:
 * - `current`    — the released version on main (one entry, when it exists)
 * - `branch`     — the working version on each active ECO/workspace/release
 *                  branch that tracks this master
 * - `historical` — every previously released revision row of the master
 *
 * File resolution mirrors the viewer's own rules (`/items/:id/cad-files` +
 * the client's pick priority): viewable extensions only, category
 * `cad_model`, from the version row itself and from the Documents it links
 * with a `CAD Doc` relationship. Files attach to a specific item *version*
 * row and carry a branch-visibility column, so:
 * - current/historical entries only see files attached to their own row that
 *   are visible outside a work branch (branchId null or main),
 * - branch entries additionally see that branch's own uploads — which may
 *   hang off the working copy row *or* the base row, depending on whether
 *   the upload happened before or after the working copy was minted — and
 *   order them ahead of the inherited baseline model.
 *
 * Each entry carries the whole candidate list in `files`, ordered so the
 * first is the one that context would display by default; `file` repeats
 * that first entry for callers that only want the default pick.
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

    // All candidate rows in one query: every row any entry can draw from.
    const candidateRowIds = new Set<string>()
    if (currentRow) candidateRowIds.add(currentRow.id)
    for (const row of historicalRows) candidateRowIds.add(row.id)
    for (const { branchItem } of activeBranches) {
      if (branchItem.currentItemId)
        candidateRowIds.add(branchItem.currentItemId)
      if (branchItem.baseItemId) candidateRowIds.add(branchItem.baseItemId)
    }

    // The Documents each candidate row links as CAD Docs, and their files.
    // The viewer's own file list includes them, so the comparison picker has
    // to as well — for many parts the geometry lives only on a linked
    // Document, and a picker that ignored them would report "no 3D model"
    // for versions the viewer is happily rendering.
    const cadDocsByRow = await this.cadDocsForRows([...candidateRowIds])
    for (const docs of cadDocsByRow.values()) {
      for (const doc of docs) candidateRowIds.add(doc.itemId)
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

    /** Files this entry can draw on, in the order the picker should show. */
    const resolveFiles = (opts: {
      /** Rows whose files this entry inherits or owns, most-specific first. */
      rowIds: Array<string>
      /** The work branch this entry reads on, or null for main-only. */
      branchId: string | null
      /** The row whose CAD Doc links apply. */
      linkRowId: string
    }): Array<ModelVersionFile> => {
      const rowIdSet = new Set(opts.rowIds)
      const visible = (f: VaultFileRow) =>
        mainVisible(f) ||
        (opts.branchId !== null && f.branchId === opts.branchId)

      const direct = viewableFiles.filter(
        (f) => rowIdSet.has(f.itemId) && visible(f),
      )
      // A branch's own uploads are its in-change model; the inherited
      // baseline is only the answer when the branch hasn't touched geometry.
      const own =
        opts.branchId !== null
          ? direct.filter((f) => f.branchId === opts.branchId)
          : []
      const inherited = direct.filter((f) => !own.includes(f))

      const docs = cadDocsByRow.get(opts.linkRowId) ?? []
      const fromDocs = docs.flatMap((doc) =>
        this.orderByPickPriority(
          viewableFiles.filter((f) => f.itemId === doc.itemId && visible(f)),
        ).map((f) => this.toDto(f, 'cad_doc', doc.itemId, doc.itemNumber)),
      )

      return [
        ...this.orderByPickPriority(own).map((f) =>
          this.toDto(f, 'direct', f.itemId, null),
        ),
        ...this.orderByPickPriority(inherited).map((f) =>
          this.toDto(f, 'direct', f.itemId, null),
        ),
        ...fromDocs,
      ]
    }

    const entries: Array<ModelVersionEntry> = []

    if (currentRow) {
      const entryFiles = resolveFiles({
        rowIds: [currentRow.id],
        branchId: null,
        linkRowId: currentRow.id,
      })
      entries.push({
        key: 'current',
        kind: 'current',
        itemId: currentRow.id,
        revision: currentRow.revision,
        state: currentRow.state,
        modifiedAt: currentRow.modifiedAt,
        branch: null,
        files: entryFiles,
        file: entryFiles.at(0) ?? null,
      })
    }

    for (const { branch, branchItem } of activeBranches) {
      const workingRow = branchItem.currentItemId
        ? masterRows.find((row) => row.id === branchItem.currentItemId)
        : undefined
      const versionRow = workingRow ?? currentRow
      if (!versionRow) continue

      const entryFiles = resolveFiles({
        rowIds: [
          branchItem.currentItemId,
          branchItem.baseItemId,
          currentRow?.id,
        ].filter((id): id is string => Boolean(id)),
        branchId: branch.id,
        linkRowId: versionRow.id,
      })

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
        files: entryFiles,
        file: entryFiles.at(0) ?? null,
      })
    }

    for (const row of historicalRows) {
      const entryFiles = resolveFiles({
        rowIds: [row.id],
        branchId: null,
        linkRowId: row.id,
      })
      entries.push({
        key: `historical:${row.id}`,
        kind: 'historical',
        itemId: row.id,
        revision: row.revision,
        state: row.state,
        modifiedAt: row.modifiedAt,
        branch: null,
        files: entryFiles,
        file: entryFiles.at(0) ?? null,
      })
    }

    return entries
  }

  /**
   * The Documents each of these item rows links with a `CAD Doc`
   * relationship. Delegates per row so stale links follow their superseding
   * revision exactly as the viewer's own `/cad-files` listing does.
   */
  private static async cadDocsForRows(
    rowIds: Array<string>,
  ): Promise<Map<string, Array<{ itemId: string; itemNumber: string }>>> {
    const pairs = await Promise.all(
      rowIds.map(async (rowId) => {
        const relationships =
          await ItemRelationshipService.getRelationshipsWithDetails(
            rowId,
            'CAD Doc',
          )
        const docs = relationships
          .map((rel) => rel.targetItem)
          .filter((target): target is NonNullable<typeof target> =>
            Boolean(target),
          )
          .map((target) => ({
            itemId: target.id,
            itemNumber: target.itemNumber,
          }))
        return [rowId, docs] as const
      }),
    )
    return new Map(pairs)
  }

  private static isViewable(fileName: string): boolean {
    const ext = fileName.toLowerCase().split('.').pop()
    return ext !== undefined && this.VIEWABLE_EXTENSIONS.has(ext)
  }

  /**
   * The client's model pick priority: GLB with embedded colors, then the
   * designated primary model, then the newest upload. Input arrives ordered
   * uploadedAt desc and the sort is stable, so the third tier stays newest
   * first.
   */
  private static orderByPickPriority(
    files: Array<VaultFileRow>,
  ): Array<VaultFileRow> {
    const rank = (f: VaultFileRow) => {
      if (this.extension(f) === 'glb' && this.hasColors(f)) return 0
      return f.isPrimaryModel === true ? 1 : 2
    }
    return [...files].sort((a, b) => rank(a) - rank(b))
  }

  private static toDto(
    file: VaultFileRow,
    source: ModelVersionFileSource,
    sourceItemId: string,
    sourceItemNumber: string | null,
  ): ModelVersionFile {
    return {
      id: file.id,
      fileName: file.originalFileName,
      fileType: this.extension(file),
      hasColors: this.hasColors(file),
      isPrimaryModel: file.isPrimaryModel === true,
      fileSize: Number(file.fileSize),
      uploadedAt: file.uploadedAt,
      source,
      sourceItemId,
      sourceItemNumber,
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

/** Whether the model hangs off the item itself or a Document it links. */
export type ModelVersionFileSource = 'direct' | 'cad_doc'

export interface ModelVersionFile {
  id: string
  fileName: string
  fileType: string
  hasColors: boolean
  isPrimaryModel: boolean
  fileSize: number
  uploadedAt: Date
  source: ModelVersionFileSource
  /** The item row the file hangs off — this version, or a linked Document. */
  sourceItemId: string
  /** Item number of the linked Document, for `cad_doc` files only. */
  sourceItemNumber: string | null
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
  /** Every viewable model this version context offers, default pick first. */
  files: Array<ModelVersionFile>
  /** The model this version context would show, or null when it has none. */
  file: ModelVersionFile | null
}
