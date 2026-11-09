// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import {
  DOCUMENT_FIELDS,
  ISSUE_FIELDS,
  PART_FIELDS,
  REQUIREMENT_FIELDS,
  importDocumentsRequestSchema,
  importIssuesRequestSchema,
  importPartsWithBomRequestSchema,
  importRequirementsRequestSchema,
} from '@cascadia/commons/import'
import { tagged } from '../adapter'
import type { ItemFieldConfig } from '@cascadia/commons/import'
import type { OpenApiMetadata } from '@/api/openapi-helpers'
import { generateXlsxTemplate } from '@/import/xlsx-template'
import { DesignService } from '@/services/DesignService'
import { AccessControlService } from '@/auth/AccessControlService'
import { apiHandler } from '@/api/handler'
import { PermissionDeniedError, ValidationError } from '@/errors'
import { requireBranchAccess, requireDesignAccess } from '@/auth/access'
import { requireRole } from '@/auth/server'
import {
  jobAccepted,
  jobAcceptedSchema,
  submitForRequest,
} from '@/jobs/accepted'
import { IMPORT_JOB_TYPES } from '@/jobs/definitions/import/config'

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
 *
 * **Every write route here queues its work and answers 202.** An import is
 * a background job on the jobs worker (`ImportService` does the writing), so
 * its size is not bounded by an HTTP request; these routes were capped at 500
 * rows when the rows were written inside one. What stays here is everything
 * that must answer before anything is queued: the request's shape, the
 * permission above, design and branch access, the administrator role for an
 * override, and the post-release branch requirement. The worker writes as the
 * submitting user and re-checks none of it.
 */
function importOpenApi(what: string, resultName: string): OpenApiMetadata {
  return {
    summary: `Import ${what} from a sheet`,
    description:
      `Queues the import as a background job and answers 202 with its id. ` +
      `Poll \`GET /api/v1/jobs/{id}\` (also given in the \`Location\` header) ` +
      `for its status and progress; once it completes, the job's \`result\` ` +
      `is the import's row-by-row outcome (\`${resultName}\`). There is no ` +
      `row limit. Runs on the jobs worker: answers 503 when the job queue ` +
      `cannot be reached.`,
    responses: {
      202: { schema: jobAcceptedSchema, description: 'Import queued' },
    },
  }
}

/**
 * The checks every design-scoped import makes before it is queued.
 *
 * A post-release design takes changes only through a branch, so an import
 * into one without a branch is refused here rather than failing every row on
 * the worker. `importAsReleased` records an existing formal release and so
 * writes to main, which is why it may not name a branch at all.
 */
async function authorizeDesignImport(
  request: Request,
  userId: string,
  body: {
    designId: string
    branchId?: string
    bypassBranchProtection: boolean
    importAsReleased: boolean
  },
): Promise<void> {
  const { designId, branchId, bypassBranchProtection, importAsReleased } = body

  if (importAsReleased && branchId) {
    throw new ValidationError(
      'Existing formal releases must be imported directly to main; do not provide a branch ID',
    )
  }

  await requireDesignAccess(userId, designId)
  if (branchId) {
    await requireBranchAccess(userId, branchId)
  }

  // Bypass branch protection requires Administrator role
  if (bypassBranchProtection || importAsReleased) {
    await requireRole(request, 'Administrator')
  }

  const designStatus = await DesignService.getProtectionStatus(designId)
  const isPostRelease = designStatus.phase === 'post-release'
  if (
    isPostRelease &&
    !bypassBranchProtection &&
    !importAsReleased &&
    !branchId
  ) {
    throw new ValidationError('Branch ID is required for post-release designs')
  }
}

// POST /api/import/documents
app.post(
  '/documents',
  adapt(
    apiHandler(
      {
        permission: ['documents', 'create'],
        body: importDocumentsRequestSchema,
        openapi: importOpenApi('documents', 'ImportResult'),
      },
      async ({ body, request, user }) => {
        await authorizeDesignImport(request, user.id, body)
        const job = await submitForRequest(
          IMPORT_JOB_TYPES.documents,
          { userId: user.id, request: body },
          user.id,
        )
        return jobAccepted(job)
      },
    ),
  ),
)

// POST /api/import/issues
app.post(
  '/issues',
  adapt(
    apiHandler(
      {
        permission: ['issues', 'create'],
        body: importIssuesRequestSchema,
        openapi: importOpenApi('issues', 'ImportResult'),
      },
      async ({ body, user }) => {
        // Verify program membership if programId is provided
        if (body.programId) {
          const canAccess = await AccessControlService.canAccessProgram(
            user.id,
            body.programId,
          )
          if (!canAccess) {
            throw new PermissionDeniedError('program', 'access')
          }
        }

        const job = await submitForRequest(
          IMPORT_JOB_TYPES.issues,
          { userId: user.id, request: body },
          user.id,
        )
        return jobAccepted(job)
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
        openapi: importOpenApi('parts and their BOM', 'BomImportResult'),
      },
      async ({ body, request, user }) => {
        await authorizeDesignImport(request, user.id, body)
        const job = await submitForRequest(
          IMPORT_JOB_TYPES.parts,
          { userId: user.id, request: body },
          user.id,
        )
        return jobAccepted(job)
      },
    ),
  ),
)

// POST /api/import/requirements
app.post(
  '/requirements',
  adapt(
    apiHandler(
      {
        permission: ['requirements', 'create'],
        body: importRequirementsRequestSchema,
        openapi: importOpenApi(
          'requirements and their hierarchy',
          'ImportRequirementsResult',
        ),
      },
      async ({ body, request, user }) => {
        await authorizeDesignImport(request, user.id, body)
        const job = await submitForRequest(
          IMPORT_JOB_TYPES.requirements,
          { userId: user.id, request: body },
          user.id,
        )
        return jobAccepted(job)
      },
    ),
  ),
)

/**
 * One template response for all four item-type endpoints: a header row plus
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

// GET /api/import/templates/requirements
app.get(
  '/templates/requirements',
  adapt(
    apiHandler({ public: true }, async ({ request }) => {
      const url = new URL(request.url)
      const format = url.searchParams.get('format') || 'csv'
      return templateResponse(REQUIREMENT_FIELDS, 'requirements', format)
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
