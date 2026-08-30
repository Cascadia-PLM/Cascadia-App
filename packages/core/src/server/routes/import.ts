// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { tagged } from '../adapter'
import type { BaseItem } from '@/lib/items/types/base'
import type {
  BomImportResult,
  ImportResult,
  ItemFieldConfig,
} from '@/lib/import'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { apiHandler, jsonResponse } from '@/lib/api/handler'
import {
  AlreadyExistsError,
  AppError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import {
  DOCUMENT_FIELDS,
  ISSUE_FIELDS,
  MAX_IMPORT_ROWS,
  PART_FIELDS,
  generateXlsxTemplate,
  importDocumentsRequestSchema,
  importIssuesRequestSchema,
  importPartsWithBomRequestSchema,
} from '@/lib/import'
import { requireBranchAccess, requireDesignAccess } from '@/lib/auth/access'
import { requireRole } from '@/lib/auth/server'
import '@/lib/items/registerItemTypes.server'

/**
 * The message a failed row or relationship may carry back to the caller.
 *
 * These handlers passed `error.message` through verbatim, which for anything
 * the service layer did not classify is the driver's exception — the full
 * INSERT with its column list and every bound parameter, once per failed row,
 * inside a 207 that a human is meant to read. An AppError's message is ours
 * and is written to be read; anything else gets the generic fallback and stays
 * in the log, where the query text belongs.
 */
function importErrorMessage(error: unknown, fallback: string): string {
  return error instanceof AppError ? error.message : fallback
}

const adapt = tagged('Import')

const app = new Hono()

/**
 * Every write route here declares the `create` permission for the item type it
 * produces, rather than settling for auth-only (`apiHandler({})`).
 *
 * Two things were wrong without it. A session user whose role lacks `create`
 * — Approver, View Only — could still bulk-create items through import,
 * routing around their own role. And `apiHandler` applies API-key scope
 * narrowing only inside its declared-permission branch, so on an undeclared
 * route a key scoped to `{ parts: ['read'] }` got full import write access;
 * the scope was inert precisely where it mattered most.
 *
 * The `bypassBranchProtection` flag is gated separately via `requireRole`,
 * which consults the key's role scope — a distinct axis from these
 * permissions. The two together are what a narrowly-scoped key needs to be
 * genuinely narrow.
 */

// POST /api/import/documents
app.post(
  '/documents',
  adapt(
    apiHandler(
      {
        permission: ['documents', 'create'],
        body: importDocumentsRequestSchema,
      },
      async ({ body, request, user }) => {
        const userId = user.id

        // Parse and validate request body
        const { designId, branchId, rows, bypassBranchProtection } = body

        // Verify design access
        await requireDesignAccess(user.id, designId)

        // Verify branch access if specified
        if (branchId) {
          await requireBranchAccess(user.id, branchId)
        }

        // Bypass branch protection requires Administrator role
        if (bypassBranchProtection) {
          await requireRole(request, 'Administrator')
        }

        // Validate row count
        if (rows.length > MAX_IMPORT_ROWS) {
          throw new ValidationError(
            `Maximum ${MAX_IMPORT_ROWS} rows per import`,
          )
        }

        // Check design exists and get protection status
        const designStatus = await DesignService.getProtectionStatus(designId)
        const isPostRelease = designStatus.phase === 'post-release'

        // If post-release and no bypass, require branchId
        if (isPostRelease && !bypassBranchProtection && !branchId) {
          throw new ValidationError(
            'Branch ID is required for post-release designs',
          )
        }

        // Process import
        const result: ImportResult = {
          totalRows: rows.length,
          successCount: 0,
          errorCount: 0,
          createdItems: [],
          failedRows: [],
        }

        // Import each row
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!
          const rowNumber = i + 2 // Row 1 is header, data starts at row 2

          try {
            // Prepare document data
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

            if (branchId && !bypassBranchProtection) {
              // Create on branch (post-release)
              const branchResult = await ItemService.createOnBranch(
                'Document',
                documentData,
                branchId,
                `Imported document: ${row.name}`,
                userId,
              )
              createdItem = branchResult.item
            } else {
              // Create directly (pre-release or bypass)
              createdItem = await ItemService.create(
                'Document',
                documentData,
                userId,
                { bypassBranchProtection: bypassBranchProtection || false },
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
        }

        // Determine response status
        let status = 201
        if (result.errorCount > 0 && result.successCount > 0) {
          status = 207 // Multi-Status
        } else if (result.errorCount > 0 && result.successCount === 0) {
          status = 400
        }

        return jsonResponse({ result }, status)
      },
    ),
  ),
)

// POST /api/import/issues
app.post(
  '/issues',
  adapt(
    apiHandler(
      { permission: ['issues', 'create'], body: importIssuesRequestSchema },
      async ({ body, user }) => {
        const userId = user.id

        // Parse and validate request body
        const { programId, rows } = body

        // Verify program membership if programId is provided
        if (programId) {
          const canAccess = await AccessControlService.canAccessProgram(
            user.id,
            programId,
          )
          if (!canAccess) {
            throw new PermissionDeniedError('program', 'access')
          }
        }

        // Validate row count
        if (rows.length > MAX_IMPORT_ROWS) {
          throw new ValidationError(
            `Maximum ${MAX_IMPORT_ROWS} rows per import`,
          )
        }

        // Process import
        const result: ImportResult = {
          totalRows: rows.length,
          successCount: 0,
          errorCount: 0,
          createdItems: [],
          failedRows: [],
        }

        // Import each row
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!
          const rowNumber = i + 2 // Row 1 is header, data starts at row 2

          try {
            // Prepare issue data
            // Issues use free lifecycle - created directly with 'Open' state
            // Issues don't follow Part/Document versioning, so revision is always '-'

            // Convert date strings to Date objects for Drizzle timestamp columns.
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

            // Issues don't have branch protection - create directly
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
        }

        // Determine response status
        let status = 201
        if (result.errorCount > 0 && result.successCount > 0) {
          status = 207 // Multi-Status
        } else if (result.errorCount > 0 && result.successCount === 0) {
          status = 400
        }

        return jsonResponse({ result }, status)
      },
    ),
  ),
)

// POST /api/import/parts
app.post(
  '/parts',
  adapt(
    apiHandler(
      {
        permission: ['parts', 'create'],
        body: importPartsWithBomRequestSchema,
      },
      async ({ body, request, user }) => {
        const userId = user.id

        // Parse and validate request body (supports BOM relationships)
        const {
          designId,
          branchId,
          rows,
          bypassBranchProtection,
          bomRelationships,
        } = body

        // Verify design access
        await requireDesignAccess(user.id, designId)

        // Verify branch access if specified
        if (branchId) {
          await requireBranchAccess(user.id, branchId)
        }

        // Bypass branch protection requires Administrator role
        if (bypassBranchProtection) {
          await requireRole(request, 'Administrator')
        }

        // Validate row count
        if (rows.length > MAX_IMPORT_ROWS) {
          throw new ValidationError(
            `Maximum ${MAX_IMPORT_ROWS} rows per import`,
          )
        }

        // Check design exists and get protection status
        const designStatus = await DesignService.getProtectionStatus(designId)
        const isPostRelease = designStatus.phase === 'post-release'

        // If post-release and no bypass, require branchId
        if (isPostRelease && !bypassBranchProtection && !branchId) {
          throw new ValidationError(
            'Branch ID is required for post-release designs',
          )
        }

        // Process import
        const result: BomImportResult = {
          totalRows: rows.length,
          successCount: 0,
          errorCount: 0,
          createdItems: [],
          failedRows: [],
          relationshipsCreated: 0,
          relationshipsFailed: 0,
          failedRelationships: [],
        }

        // Import each row
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!
          const rowNumber = i + 2 // Row 1 is header, data starts at row 2

          try {
            // Prepare part data
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

            if (branchId && !bypassBranchProtection) {
              // Create on branch (post-release)
              const branchResult = await ItemService.createOnBranch(
                'Part',
                partData,
                branchId,
                `Imported part: ${row.name}`,
                userId,
              )
              createdItem = branchResult.item
            } else {
              // Create directly (pre-release or bypass)
              createdItem = await ItemService.create('Part', partData, userId, {
                bypassBranchProtection: bypassBranchProtection || false,
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
        }

        // Process BOM relationships if provided and parts were created
        if (
          bomRelationships &&
          bomRelationships.length > 0 &&
          result.successCount > 0
        ) {
          // Build itemNumber -> itemId map from created items
          const itemNumberToId = new Map<string, string>()
          for (const item of result.createdItems) {
            itemNumberToId.set(item.itemNumber.toLowerCase(), item.itemId)
          }

          // Resolve the parents/children this import references but did not
          // create. Looked up by exact item number rather than by paging a
          // search: a page cap here silently mapped nothing for designs
          // larger than the page, and every such relationship then failed
          // with a "not found" naming an item that plainly existed.
          const referenced = bomRelationships.flatMap((rel) => [
            rel.parentItemNumber,
            rel.childItemNumber,
          ])
          // `.toLowerCase()` with no trim, matching how this map is keyed
          // above and read below
          const unresolved = referenced.filter(
            (n) => !itemNumberToId.has(n.toLowerCase()),
          )

          if (unresolved.length > 0) {
            // A failure here makes every external reference look missing, so
            // it fails the request rather than degrading to a misleading
            // per-relationship error.
            const existing = await ItemService.findIdsByItemNumbers(
              unresolved,
              { designIds: [designId], currentOnly: true },
            )
            for (const [itemNumber, id] of existing) {
              if (!itemNumberToId.has(itemNumber)) {
                itemNumberToId.set(itemNumber, id)
              }
            }
          }

          // A parent lists a child once: `item_relationships` is unique on
          // (source, target, type), so a file naming the same child on two
          // lines has one edge to give. Caught here rather than at the insert,
          // where the collision is reported in item ids the caller never saw
          // and the second line's quantity is simply lost.
          const seenEdges = new Set<string>()

          // Process each relationship
          for (const rel of bomRelationships) {
            const edgeKey = `${rel.parentItemNumber.toLowerCase()}\u0000${rel.childItemNumber.toLowerCase()}`
            if (seenEdges.has(edgeKey)) {
              result.relationshipsFailed++
              result.failedRelationships.push({
                parentItemNumber: rel.parentItemNumber,
                childItemNumber: rel.childItemNumber,
                error:
                  `${rel.parentItemNumber} already lists ${rel.childItemNumber} ` +
                  'on an earlier line; combine the lines and sum their quantities',
              })
              continue
            }
            seenEdges.add(edgeKey)

            const parentId = itemNumberToId.get(
              rel.parentItemNumber.toLowerCase(),
            )
            const childId = itemNumberToId.get(
              rel.childItemNumber.toLowerCase(),
            )

            if (!parentId) {
              result.relationshipsFailed++
              result.failedRelationships.push({
                parentItemNumber: rel.parentItemNumber,
                childItemNumber: rel.childItemNumber,
                error: `Parent item not found: ${rel.parentItemNumber}`,
              })
              continue
            }

            if (!childId) {
              result.relationshipsFailed++
              result.failedRelationships.push({
                parentItemNumber: rel.parentItemNumber,
                childItemNumber: rel.childItemNumber,
                error: `Child item not found: ${rel.childItemNumber}`,
              })
              continue
            }

            try {
              // Bulk import wires up items it just created — a system flow,
              // exempt from the per-user edit lock.
              await ItemService.addRelationship(
                parentId,
                childId,
                'BOM',
                userId,
                {
                  quantity: String(rel.quantity),
                  findNumber: rel.findNumber,
                  referenceDesignator: rel.referenceDesignator,
                },
                { bypassEditGuard: true },
              )
              result.relationshipsCreated++
            } catch (error) {
              result.relationshipsFailed++
              result.failedRelationships.push({
                parentItemNumber: rel.parentItemNumber,
                childItemNumber: rel.childItemNumber,
                // The service names the edge by item id, which is meaningless
                // to someone looking at the spreadsheet they uploaded.
                error:
                  error instanceof AlreadyExistsError
                    ? `${rel.parentItemNumber} already lists ${rel.childItemNumber}`
                    : importErrorMessage(
                        error,
                        'Failed to create relationship',
                      ),
              })
            }
          }
        }

        // Determine response status
        // 201 if all succeeded
        // 207 if some succeeded and some failed
        // 400 if all failed
        let status = 201
        const totalErrors = result.errorCount + result.relationshipsFailed
        const totalSuccesses = result.successCount + result.relationshipsCreated
        if (totalErrors > 0 && totalSuccesses > 0) {
          status = 207 // Multi-Status
        } else if (result.errorCount > 0 && result.successCount === 0) {
          status = 400
        }

        return jsonResponse({ result }, status)
      },
    ),
  ),
)

/**
 * One template response for all three item-type endpoints: a header row plus
 * an example row built from the field config, as CSV (default) or a real
 * XLSX workbook. `format=xlsx` used to silently return CSV; the parameter
 * now means what it says, and an unknown format is a 400 rather than a
 * silent fallback — this surface freezes at v0.5.
 */
async function templateResponse(
  fields: Array<ItemFieldConfig>,
  resource: string,
  format: string,
): Promise<Response> {
  if (format === 'xlsx') {
    const buffer = await generateXlsxTemplate(fields, `${resource} import`)
    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${resource}-import-template.xlsx"`,
      },
    })
  }

  if (format !== 'csv') {
    throw new ValidationError(`Unsupported template format: ${format}`)
  }

  const escapeCsv = (val: string) =>
    val.includes(',') || val.includes('"') || val.includes('\n')
      ? `"${val.replace(/"/g, '""')}"`
      : val
  const csvContent = [
    fields.map((field) => field.label).join(','),
    fields.map((field) => escapeCsv(field.example || '')).join(','),
  ].join('\n')

  return new Response(csvContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${resource}-import-template.csv"`,
    },
  })
}

// GET /api/import/templates/documents
app.get(
  '/templates/documents',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'csv'
      return templateResponse(DOCUMENT_FIELDS, 'documents', format)
    }),
  ),
)

// GET /api/import/templates/issues
app.get(
  '/templates/issues',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'csv'
      return templateResponse(ISSUE_FIELDS, 'issues', format)
    }),
  ),
)

// GET /api/import/templates/parts
app.get(
  '/templates/parts',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'csv'
      return templateResponse(PART_FIELDS, 'parts', format)
    }),
  ),
)

export default app
