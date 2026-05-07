import { Hono } from 'hono'
import { adapt } from '../adapter'
import type { BaseItem } from '@/lib/items/types/base'
import type { BomImportResult, ImportResult } from '@/lib/import'
import { ItemService } from '@/lib/items/services/ItemService'
import { DesignService } from '@/lib/services/DesignService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { apiHandler, jsonResponse } from '@/lib/api/handler'
import { PermissionDeniedError, ValidationError } from '@/lib/errors'
import {
  DOCUMENT_FIELDS,
  ISSUE_FIELDS,
  PART_FIELDS,
  importDocumentsRequestSchema,
  importIssuesRequestSchema,
  importPartsWithBomRequestSchema,
} from '@/lib/import'
import { requireBranchAccess, requireDesignAccess } from '@/lib/auth/access'
import { requireRole } from '@/lib/auth/server'
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// POST /api/import/documents
app.post(
  '/documents',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const userId = user.id

      // Parse and validate request body
      const body = await request.json()
      const parseResult = importDocumentsRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const { designId, branchId, rows, bypassBranchProtection } =
        parseResult.data

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
      if (rows.length > 500) {
        throw new ValidationError('Maximum 500 rows per import')
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
        const row = rows[i]
        const rowNumber = i + 2 // Row 1 is header, data starts at row 2

        try {
          // Prepare document data
          const documentData = {
            itemType: 'Document' as const,
            designId,
            name: row.name,
            revision: row.revision || '-',
            state: 'Draft',
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
              documentData as unknown as BaseItem,
              branchId,
              `Imported document: ${row.name}`,
              userId,
            )
            createdItem = branchResult.item
          } else {
            // Create directly (pre-release or bypass)
            createdItem = await ItemService.create(
              'Document',
              documentData as unknown as BaseItem,
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
            errors: [
              error instanceof Error
                ? error.message
                : 'Failed to create document',
            ],
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
    }),
  ),
)

// POST /api/import/issues
app.post(
  '/issues',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const userId = user.id

      // Parse and validate request body
      const body = await request.json()
      const parseResult = importIssuesRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const { programId, rows } = parseResult.data

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
      if (rows.length > 500) {
        throw new ValidationError('Maximum 500 rows per import')
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
        const row = rows[i]
        const rowNumber = i + 2 // Row 1 is header, data starts at row 2

        try {
          // Prepare issue data
          // Issues use free lifecycle - created directly with 'Open' state
          // Issues don't follow Part/Document versioning, so revision is always '-'

          // Convert date strings to Date objects for Drizzle timestamp columns
          const reportedDate = row.reportedDate
            ? row.reportedDate instanceof Date
              ? row.reportedDate
              : new Date(row.reportedDate)
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
          const createdItem = await ItemService.create(
            'Issue',
            issueData as unknown as BaseItem,
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
            errors: [
              error instanceof Error ? error.message : 'Failed to create issue',
            ],
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
    }),
  ),
)

// POST /api/import/parts
app.post(
  '/parts',
  adapt(
    apiHandler({}, async ({ request, user }) => {
      const userId = user.id

      // Parse and validate request body (supports BOM relationships)
      const body = await request.json()
      const parseResult = importPartsWithBomRequestSchema.safeParse(body)

      if (!parseResult.success) {
        throw ValidationError.fromZodError(parseResult.error)
      }

      const {
        designId,
        branchId,
        rows,
        bypassBranchProtection,
        bomRelationships,
      } = parseResult.data

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
      if (rows.length > 500) {
        throw new ValidationError('Maximum 500 rows per import')
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
        const row = rows[i]
        const rowNumber = i + 2 // Row 1 is header, data starts at row 2

        try {
          // Prepare part data
          const partData = {
            itemType: 'Part' as const,
            designId,
            name: row.name,
            revision: row.revision || '-',
            state: 'Draft',
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
              partData as unknown as BaseItem,
              branchId,
              `Imported part: ${row.name}`,
              userId,
            )
            createdItem = branchResult.item
          } else {
            // Create directly (pre-release or bypass)
            createdItem = await ItemService.create(
              'Part',
              partData as unknown as BaseItem,
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
            errors: [
              error instanceof Error ? error.message : 'Failed to create part',
            ],
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

        // Also lookup existing items in design for external parents
        try {
          const existingItemsResult = await ItemService.search('Part', {
            designId,
            limit: 1000,
            currentOnly: true,
          })
          for (const item of existingItemsResult.items) {
            if (
              item.itemNumber &&
              item.id &&
              !itemNumberToId.has(item.itemNumber.toLowerCase())
            ) {
              itemNumberToId.set(item.itemNumber.toLowerCase(), item.id)
            }
          }
        } catch (error) {
          console.warn(
            'Failed to lookup existing items for BOM relationships:',
            error,
          )
        }

        // Process each relationship
        for (const rel of bomRelationships) {
          const parentId = itemNumberToId.get(
            rel.parentItemNumber.toLowerCase(),
          )
          const childId = itemNumberToId.get(rel.childItemNumber.toLowerCase())

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
            )
            result.relationshipsCreated++
          } catch (error) {
            result.relationshipsFailed++
            result.failedRelationships.push({
              parentItemNumber: rel.parentItemNumber,
              childItemNumber: rel.childItemNumber,
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to create relationship',
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
    }),
  ),
)

// GET /api/import/templates/documents
app.get(
  '/templates/documents',
  adapt(
    // eslint-disable-next-line @typescript-eslint/require-await -- apiHandler signature requires async
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'csv'

      // Build header row from DOCUMENT_FIELDS
      const headers = DOCUMENT_FIELDS.map((field) => field.label)

      // Build example row
      const exampleRow = DOCUMENT_FIELDS.map((field) => field.example || '')

      if (format === 'csv') {
        // Generate CSV content
        const csvContent = [
          headers.join(','),
          exampleRow
            .map((val) => {
              // Escape values with commas or quotes
              if (
                val.includes(',') ||
                val.includes('"') ||
                val.includes('\n')
              ) {
                return `"${val.replace(/"/g, '""')}"`
              }
              return val
            })
            .join(','),
        ].join('\n')

        return new Response(csvContent, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition':
              'attachment; filename="documents-import-template.csv"',
          },
        })
      }

      // For XLSX, we would need to use xlsx library
      // For now, return CSV as default
      const csvContent = [
        headers.join(','),
        exampleRow
          .map((val) => {
            if (val.includes(',') || val.includes('"') || val.includes('\n')) {
              return `"${val.replace(/"/g, '""')}"`
            }
            return val
          })
          .join(','),
      ].join('\n')

      return new Response(csvContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition':
            'attachment; filename="documents-import-template.csv"',
        },
      })
    }),
  ),
)

// GET /api/import/templates/issues
app.get(
  '/templates/issues',
  adapt(
    // eslint-disable-next-line @typescript-eslint/require-await -- apiHandler signature requires async
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'csv'

      // Build header row from ISSUE_FIELDS
      const headers = ISSUE_FIELDS.map((field) => field.label)

      // Build example row
      const exampleRow = ISSUE_FIELDS.map((field) => field.example || '')

      if (format === 'csv') {
        // Generate CSV content
        const csvContent = [
          headers.join(','),
          exampleRow
            .map((val) => {
              // Escape values with commas or quotes
              if (
                val.includes(',') ||
                val.includes('"') ||
                val.includes('\n')
              ) {
                return `"${val.replace(/"/g, '""')}"`
              }
              return val
            })
            .join(','),
        ].join('\n')

        return new Response(csvContent, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition':
              'attachment; filename="issues-import-template.csv"',
          },
        })
      }

      // For XLSX, we would need to use xlsx library
      // For now, return CSV as default
      const csvContent = [
        headers.join(','),
        exampleRow
          .map((val) => {
            if (val.includes(',') || val.includes('"') || val.includes('\n')) {
              return `"${val.replace(/"/g, '""')}"`
            }
            return val
          })
          .join(','),
      ].join('\n')

      return new Response(csvContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition':
            'attachment; filename="issues-import-template.csv"',
        },
      })
    }),
  ),
)

// GET /api/import/templates/parts
app.get(
  '/templates/parts',
  adapt(
    // eslint-disable-next-line @typescript-eslint/require-await -- apiHandler signature requires async
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'csv'

      // Build header row from PART_FIELDS
      const headers = PART_FIELDS.map((field) => field.label)

      // Build example row
      const exampleRow = PART_FIELDS.map((field) => field.example || '')

      if (format === 'csv') {
        // Generate CSV content
        const csvContent = [
          headers.join(','),
          exampleRow
            .map((val) => {
              // Escape values with commas or quotes
              if (
                val.includes(',') ||
                val.includes('"') ||
                val.includes('\n')
              ) {
                return `"${val.replace(/"/g, '""')}"`
              }
              return val
            })
            .join(','),
        ].join('\n')

        return new Response(csvContent, {
          status: 200,
          headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition':
              'attachment; filename="parts-import-template.csv"',
          },
        })
      }

      // For XLSX, we would need to use xlsx library
      // For now, return CSV as default
      const csvContent = [
        headers.join(','),
        exampleRow
          .map((val) => {
            if (val.includes(',') || val.includes('"') || val.includes('\n')) {
              return `"${val.replace(/"/g, '""')}"`
            }
            return val
          })
          .join(','),
      ].join('\n')

      return new Response(csvContent, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition':
            'attachment; filename="parts-import-template.csv"',
        },
      })
    }),
  ),
)

export default app
