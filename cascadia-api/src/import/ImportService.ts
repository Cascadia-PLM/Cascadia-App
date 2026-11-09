// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { planRequirementHierarchy } from '@cascadia/commons/import'
import { referenceDesignatorKey } from '@cascadia/commons/types/bom'
import {
  optionConditionKey,
  parseOptionText,
} from '@cascadia/commons/types/variants'
import { formatCount, throwIfStopped } from './bulk-run'
import type { BulkRunOptions } from './bulk-run'
import type { BaseItem } from '@cascadia/commons/items/types/base'
import type {
  BomImportResult,
  ImportDocumentsRequest,
  ImportIssuesRequest,
  ImportPartsWithBomRequest,
  ImportRequirementsRequest,
  ImportRequirementsResult,
  ImportResult,
} from '@cascadia/commons/import'
import { ItemService } from '@/items/services/ItemService'
import { AlreadyExistsError, AppError } from '@/errors'
import '@/items/registerItemTypes.server'

/**
 * The message a failed row or relationship may carry back to the caller.
 *
 * These loops passed `error.message` through verbatim, which for anything
 * the service layer did not classify is the driver's exception — the full
 * INSERT with its column list and every bound parameter, once per failed row,
 * inside a result that a human is meant to read. An AppError's message is ours
 * and is written to be read; anything else gets the generic fallback and stays
 * in the log, where the query text belongs.
 */
function importErrorMessage(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback
}

/** Row 1 is the header, so a sheet's data starts at row 2. */
const FIRST_DATA_ROW = 2

/**
 * Whether a design-scoped import writes on its branch or directly.
 *
 * A branch id with neither override means the post-release path: every row is
 * a commit on that branch. Otherwise the row is created directly — pre-release
 * designs, an administrator's bypass, or a formal release imported as such.
 */
function writesOnBranch(request: {
  branchId?: string
  bypassBranchProtection: boolean
  importAsReleased: boolean
}): request is { branchId: string } & typeof request {
  return Boolean(
    request.branchId &&
    !request.bypassBranchProtection &&
    !request.importAsReleased,
  )
}

function emptyResult(totalRows: number): ImportResult {
  return {
    totalRows,
    successCount: 0,
    errorCount: 0,
    createdItems: [],
    failedRows: [],
  }
}

/**
 * Sheet imports: parts (with their BOM), documents, requirements (with their
 * hierarchy) and issues.
 *
 * Each method creates its rows one at a time and reports every row's outcome,
 * so one bad row never costs the rest of the sheet. They run on the jobs
 * worker — the `/api/v1/import/*` routes authorize the request and submit it
 * as a job — and they assume that authorization has happened: design access,
 * branch access, the administrator role for `bypassBranchProtection` and
 * `importAsReleased`, and the post-release branch requirement are all the
 * route's to check before anything is queued.
 *
 * There is no row cap. The run is bounded by its job's timeout and stops
 * between rows when its signal aborts; see `BulkRunOptions`.
 */
export class ImportService {
  static async importDocuments(
    request: ImportDocumentsRequest,
    userId: string,
    options: BulkRunOptions = {},
  ): Promise<ImportResult> {
    const { designId, rows, bypassBranchProtection, importAsReleased } = request
    const result = emptyResult(rows.length)

    for (const [i, row] of rows.entries()) {
      throwIfStopped(options.signal)
      const rowNumber = i + FIRST_DATA_ROW

      try {
        const documentData = {
          itemType: 'Document' as const,
          designId,
          name: row.name,
          revision: row.revision || '-',
          itemNumber: row.itemNumber,
          description: row.description,
          docType: row.docType,
          fileName: row.fileName,
          mimeType: row.mimeType,
          attributes: row.attributes,
        }

        let createdItem: BaseItem
        if (writesOnBranch(request)) {
          const branchResult = await ItemService.createOnBranch(
            'Document',
            documentData,
            request.branchId,
            `Imported document: ${row.name}`,
            userId,
          )
          createdItem = branchResult.item
        } else {
          createdItem = await ItemService.create(
            'Document',
            documentData,
            userId,
            {
              bypassBranchProtection:
                bypassBranchProtection || importAsReleased,
              importAsReleased,
            },
          )
        }

        result.successCount++
        result.createdItems.push({
          rowNumber,
          itemId: createdItem.id!,
          itemNumber: createdItem.itemNumber!,
        })
      } catch (error) {
        console.error(`Import row ${rowNumber} failed:`, error)
        result.errorCount++
        result.failedRows.push({
          rowNumber,
          errors: [importErrorMessage(error, 'Failed to create document')],
        })
      }

      await options.onProgress?.({
        done: i + 1,
        total: rows.length,
        message: `Processed ${formatCount(i + 1)} of ${formatCount(rows.length)} rows`,
      })
    }

    return result
  }

  static async importIssues(
    request: ImportIssuesRequest,
    userId: string,
    options: BulkRunOptions = {},
  ): Promise<ImportResult> {
    const { programId, rows } = request
    const result = emptyResult(rows.length)

    for (const [i, row] of rows.entries()) {
      throwIfStopped(options.signal)
      const rowNumber = i + FIRST_DATA_ROW

      try {
        // Issues use the free lifecycle — created directly in 'Open' — and do
        // not follow Part/Document versioning, so revision is always '-'.
        //
        // Date strings become Date objects for Drizzle's timestamp column.
        // Import rows are parsed from CSV/JSON, so this is always a string.
        const reportedDate = row.reportedDate
          ? new Date(row.reportedDate)
          : undefined

        const issueData = {
          itemType: 'Issue' as const,
          name: row.name,
          state: 'Open',
          revision: '-',
          itemNumber: row.itemNumber,
          description: row.description,
          severity: row.severity,
          priority: row.priority,
          category: row.category,
          reportedDate:
            reportedDate && !isNaN(reportedDate.getTime())
              ? reportedDate
              : undefined,
          resolution: row.resolution,
          rootCause: row.rootCause,
          programId,
          attributes: row.attributes,
        }

        // Issues have no branch protection — created directly.
        const createdItem: BaseItem = await ItemService.create(
          'Issue',
          issueData,
          userId,
          { bypassBranchProtection: true },
        )

        result.successCount++
        result.createdItems.push({
          rowNumber,
          itemId: createdItem.id!,
          itemNumber: createdItem.itemNumber!,
        })
      } catch (error) {
        console.error(`Import row ${rowNumber} failed:`, error)
        result.errorCount++
        result.failedRows.push({
          rowNumber,
          errors: [importErrorMessage(error, 'Failed to create issue')],
        })
      }

      await options.onProgress?.({
        done: i + 1,
        total: rows.length,
        message: `Processed ${formatCount(i + 1)} of ${formatCount(rows.length)} rows`,
      })
    }

    return result
  }

  static async importParts(
    request: ImportPartsWithBomRequest,
    userId: string,
    options: BulkRunOptions = {},
  ): Promise<BomImportResult> {
    const {
      designId,
      rows,
      bypassBranchProtection,
      importAsReleased,
      bomRelationships = [],
    } = request

    const result: BomImportResult = {
      ...emptyResult(rows.length),
      relationshipsCreated: 0,
      relationshipsFailed: 0,
      failedRelationships: [],
    }

    // Rows first, then the BOM lines between them: one progress bar over both.
    const total = rows.length + bomRelationships.length
    let done = 0

    for (const [i, row] of rows.entries()) {
      throwIfStopped(options.signal)
      const rowNumber = i + FIRST_DATA_ROW

      try {
        const partData = {
          itemType: 'Part' as const,
          designId,
          name: row.name,
          revision: row.revision || '-',
          itemNumber: row.itemNumber,
          description: row.description,
          partType: row.partType,
          material: row.material,
          weight: row.weight,
          weightUnit: row.weightUnit,
          cost: row.cost,
          costCurrency: row.costCurrency,
          leadTimeDays: row.leadTimeDays,
          attributes: row.attributes,
        }

        let createdItem: BaseItem
        if (writesOnBranch(request)) {
          const branchResult = await ItemService.createOnBranch(
            'Part',
            partData,
            request.branchId,
            `Imported part: ${row.name}`,
            userId,
          )
          createdItem = branchResult.item
        } else {
          createdItem = await ItemService.create('Part', partData, userId, {
            bypassBranchProtection: bypassBranchProtection || importAsReleased,
            importAsReleased,
          })
        }

        result.successCount++
        result.createdItems.push({
          rowNumber,
          itemId: createdItem.id!,
          itemNumber: createdItem.itemNumber!,
        })
      } catch (error) {
        console.error(`Import row ${rowNumber} failed:`, error)
        result.errorCount++
        result.failedRows.push({
          rowNumber,
          errors: [importErrorMessage(error, 'Failed to create part')],
        })
      }

      done++
      await options.onProgress?.({
        done,
        total,
        message: `Processed ${formatCount(i + 1)} of ${formatCount(rows.length)} rows`,
      })
    }

    if (bomRelationships.length > 0 && result.successCount > 0) {
      // itemNumber -> itemId for the parts this import created
      const itemNumberToId = new Map<string, string>()
      for (const item of result.createdItems) {
        itemNumberToId.set(item.itemNumber.toLowerCase(), item.itemId)
      }

      // Resolve the parents/children this import references but did not
      // create. Looked up by exact item number rather than by paging a
      // search: a page cap here silently mapped nothing for designs larger
      // than the page, and every such relationship then failed with a "not
      // found" naming an item that plainly existed.
      //
      // `.toLowerCase()` with no trim, matching how this map is keyed above
      // and read below.
      const unresolved = bomRelationships
        .flatMap((rel) => [rel.parentItemNumber, rel.childItemNumber])
        .filter((n) => !itemNumberToId.has(n.toLowerCase()))

      if (unresolved.length > 0) {
        // A failure here makes every external reference look missing, so it
        // fails the run rather than degrading to a misleading
        // per-relationship error.
        const existing = await ItemService.findIdsByItemNumbers(unresolved, {
          designIds: [designId],
          currentOnly: true,
        })
        for (const [itemNumber, id] of existing) {
          if (!itemNumberToId.has(itemNumber)) {
            itemNumberToId.set(itemNumber, id)
          }
        }
      }

      // Keep this identity aligned with ItemRelationshipService.edgeKey and
      // the unique index: one child may occur more than once when its option
      // condition, selected execution or reference designators differ.
      const seenEdges = new Set<string>()

      for (const [r, rel] of bomRelationships.entries()) {
        throwIfStopped(options.signal)
        await this.importBomLine(rel, itemNumberToId, seenEdges, userId, result)

        done++
        await options.onProgress?.({
          done,
          total,
          message: `Processed ${formatCount(r + 1)} of ${formatCount(bomRelationships.length)} BOM lines`,
        })
      }
    }

    return result
  }

  /** One BOM line of a parts import, its outcome recorded on `result`. */
  private static async importBomLine(
    rel: NonNullable<ImportPartsWithBomRequest['bomRelationships']>[number],
    itemNumberToId: Map<string, string>,
    seenEdges: Set<string>,
    userId: string,
    result: BomImportResult,
  ): Promise<void> {
    const fail = (error: string) => {
      result.relationshipsFailed++
      result.failedRelationships.push({
        parentItemNumber: rel.parentItemNumber,
        childItemNumber: rel.childItemNumber,
        error,
      })
    }

    const parentId = itemNumberToId.get(rel.parentItemNumber.toLowerCase())
    if (!parentId) {
      fail(`Parent item not found: ${rel.parentItemNumber}`)
      return
    }
    const childId = itemNumberToId.get(rel.childItemNumber.toLowerCase())
    if (!childId) {
      fail(`Child item not found: ${rel.childItemNumber}`)
      return
    }

    try {
      const option = rel.option ? parseOptionText(rel.option) : null
      const edgeKey = [
        rel.parentItemNumber.toLowerCase(),
        rel.childItemNumber.toLowerCase(),
        optionConditionKey(option),
        rel.targetMakeCode?.trim().toUpperCase() ?? '',
        referenceDesignatorKey('BOM', rel.referenceDesignator),
      ].join('\u0000')
      if (seenEdges.has(edgeKey)) {
        fail(
          `${rel.parentItemNumber} already lists ${rel.childItemNumber} ` +
            'with the same option condition, target execution and reference designators on an earlier line; combine the lines and sum their quantities, or give each its own reference designators',
        )
        return
      }
      seenEdges.add(edgeKey)

      // Bulk import wires up items it just created — a system flow, exempt
      // from the per-user edit lock.
      await ItemService.addRelationship(
        parentId,
        childId,
        'BOM',
        userId,
        {
          quantity: String(rel.quantity),
          findNumber: rel.findNumber,
          referenceDesignator: rel.referenceDesignator,
          option,
          targetMakeCode: rel.targetMakeCode,
        },
        { bypassEditGuard: true },
      )
      result.relationshipsCreated++
    } catch (error) {
      // The service names the edge by item id, which is meaningless to
      // someone looking at the spreadsheet they uploaded.
      fail(
        error instanceof AlreadyExistsError
          ? `${rel.parentItemNumber} already lists ${rel.childItemNumber}`
          : importErrorMessage(error, 'Failed to create relationship'),
      )
    }
  }

  static async importRequirements(
    request: ImportRequirementsRequest,
    userId: string,
    options: BulkRunOptions = {},
  ): Promise<ImportRequirementsResult> {
    const { designId, rows, bypassBranchProtection, importAsReleased } = request

    const result: ImportRequirementsResult = {
      ...emptyResult(rows.length),
      parentsLinked: 0,
    }
    const failedRowNumbers = new Set<number>()
    const fail = (rowNumber: number, message: string) => {
      result.errorCount++
      result.failedRows.push({ rowNumber, errors: [message] })
      failedRowNumbers.add(rowNumber)
    }

    // Parents first. The plan orders the sheet so a parent is created before
    // its children, and names the rows no order can satisfy — a row that is
    // its own parent, a chain of parents that loops.
    const plan = planRequirementHierarchy(
      rows.map((row, i) => ({
        rowNumber: i + FIRST_DATA_ROW,
        itemNumber: row.itemNumber,
        parentItemNumber: row.parentItemNumber,
      })),
    )
    for (const [rowNumber, message] of plan.errors) fail(rowNumber, message)

    // A parent the sheet names but does not define is one the design already
    // holds — looked up by exact item number, current rows only, the way the
    // BOM import resolves an external parent.
    const existingByNumber =
      plan.externalParents.length > 0
        ? await ItemService.findIdsByItemNumbers(plan.externalParents, {
            designIds: [designId],
            currentOnly: true,
          })
        : new Map<string, string>()
    const createdByNumber = new Map<string, string>()

    // One row of the plan: resolve its parent, then create it.
    const importRow = async (rowNumber: number): Promise<void> => {
      const row = rows[rowNumber - FIRST_DATA_ROW]!
      let parentRequirementId: string | undefined
      if (row.parentItemNumber) {
        const key = row.parentItemNumber.trim().toLowerCase()
        const parentRow = plan.parentRow.get(rowNumber)
        if (parentRow !== undefined) {
          if (failedRowNumbers.has(parentRow)) {
            fail(
              rowNumber,
              `Parent requirement ${row.parentItemNumber} (row ${parentRow}) was not imported`,
            )
            return
          }
          parentRequirementId = createdByNumber.get(key)
        } else {
          parentRequirementId = existingByNumber.get(key)
        }
        if (!parentRequirementId) {
          fail(
            rowNumber,
            `Parent requirement not found: ${row.parentItemNumber}`,
          )
          return
        }
      }

      try {
        const requirementData = {
          itemType: 'Requirement' as const,
          designId,
          name: row.name,
          revision: row.revision || '-',
          itemNumber: row.itemNumber,
          description: row.description,
          type: row.type,
          priority: row.priority,
          category: row.category,
          source: row.source,
          acceptanceCriteria: row.acceptanceCriteria,
          verificationMethod: row.verificationMethod,
          parentRequirementId,
          attributes: row.attributes,
        }

        let createdItem: BaseItem
        if (writesOnBranch(request)) {
          const branchResult = await ItemService.createOnBranch(
            'Requirement',
            requirementData,
            request.branchId,
            `Imported requirement: ${row.name}`,
            userId,
          )
          createdItem = branchResult.item
        } else {
          createdItem = await ItemService.create(
            'Requirement',
            requirementData,
            userId,
            {
              bypassBranchProtection:
                bypassBranchProtection || importAsReleased,
              importAsReleased,
            },
          )
        }

        result.successCount++
        result.createdItems.push({
          rowNumber,
          itemId: createdItem.id!,
          itemNumber: createdItem.itemNumber!,
        })
        if (parentRequirementId) result.parentsLinked++
        if (createdItem.itemNumber) {
          createdByNumber.set(
            createdItem.itemNumber.trim().toLowerCase(),
            createdItem.id!,
          )
        }
      } catch (error) {
        console.error(`Import row ${rowNumber} failed:`, error)
        fail(
          rowNumber,
          importErrorMessage(error, 'Failed to create requirement'),
        )
      }
    }

    // Progress counts every row: the ones the plan refused are already done.
    let done = plan.errors.size

    for (const rowNumber of plan.order) {
      throwIfStopped(options.signal)
      await importRow(rowNumber)
      done++
      await options.onProgress?.({
        done,
        total: rows.length,
        message: `Processed ${formatCount(done)} of ${formatCount(rows.length)} rows`,
      })
    }

    // The sheet's order back, so a caller reads failures top to bottom.
    result.failedRows.sort((a, b) => a.rowNumber - b.rowNumber)
    return result
  }
}
