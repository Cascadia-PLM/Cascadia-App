// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import { FileService } from '@/lib/vault/services/FileService'
import { JobService } from '@/lib/jobs/JobService'
import { apiHandler, jsonResponse, parseQuery } from '@/lib/api/handler'
import {
  FileTooLargeError,
  FileTypeNotAllowedError,
  NotFoundError,
  PermissionDeniedError,
  ValidationError,
} from '@/lib/errors'
import { requireFileAccess } from '@/lib/auth/access'
import { requirePermission } from '@/lib/auth/server'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { mountRoutes } from '@/lib/api/route-registry'
import {
  batchFileCheckinRequestSchema,
  batchFileCheckoutRequestSchema,
} from '@/lib/api/schemas'
import {
  CATEGORY_SOURCES,
  FILE_CATEGORY_VALUES,
} from '@/lib/vault/file-categories'
import {
  PREVIEWABLE_EXTENSIONS,
  maxPreviewBytesFor,
  previewFormatFor,
} from '@/lib/vault/preview'
import {
  createAnnotationSchema,
  updateAnnotationSchema,
} from '@/lib/vault/annotations'
import { AnnotationService } from '@/lib/vault/services/AnnotationService'
import { WATERMARK_POSITIONS } from '@/lib/vault/pdf/watermark'

const adapt = tagged('Files')

const CAD_EXTENSIONS = new Set(['.step', '.stp', '.iges', '.igs'])

/**
 * Turn an access failure into a per-file entry for the batch endpoints.
 *
 * The batch routes answer 200 / 207 / 400 over a list, so a file the caller
 * cannot reach is that file's own result rather than the whole request's. It
 * is reported as its own reason, not folded into "failed to check in", so the
 * caller can tell "this is not yours" from "this is locked by someone else".
 *
 * Returns null for anything else, which the existing catch handles.
 */
function batchDenial(
  error: unknown,
): { error: string; details?: string } | null {
  if (error instanceof NotFoundError) return { error: 'File not found' }
  if (error instanceof PermissionDeniedError) return { error: 'Access denied' }
  if (
    error instanceof ValidationError &&
    error.message === 'File has been deleted'
  ) {
    return { error: 'File has been deleted' }
  }
  return null
}

const convertInputSchema = z.object({
  meshQuality: z.enum(['preview', 'standard', 'high']).default('standard'),
  decompose: z
    .boolean()
    .default(false)
    .describe(
      'Split a multi-solid assembly into one mesh per solid instead of one ' +
        'mesh for the whole file.',
    ),
  targetItemId: z
    .string()
    .uuid()
    .optional()
    .describe(
      'Attach the converted mesh to this item instead of the source ' +
        'file’s own — e.g. a STEP held on a Document producing an STL on ' +
        'the Part.',
    ),
})

const setFileCategorySchema = z.object({
  /** `null` clears a manual override and falls back to auto-detection. */
  category: z.enum(FILE_CATEGORY_VALUES).nullable(),
})

const watermarkRequestSchema = z.object({
  text: z.string().min(1).max(120),
  subtext: z.string().max(200).nullable().optional(),
  position: z.enum(WATERMARK_POSITIONS).default('diagonal'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#dc2626'),
  opacity: z.number().min(0.05).max(1).default(0.25),
  reason: z.string().max(200).optional(),
})

interface BatchFileCheckinResult {
  checkedIn: Array<{
    fileId: string
    fileName: string
  }>
  errors: Array<{
    fileId: string
    error: string
    details?: string
  }>
}

interface BatchFileCheckoutResult {
  checkedOut: Array<{
    fileId: string
    fileName: string
    checkedOutAt: Date
  }>
  errors: Array<{
    fileId: string
    error: string
    details?: string
  }>
}

const app = new Hono()

// File actions belonging to optional packages — PDF signing, for one. Mounted
// first so a contributed static path cannot be swallowed by a parameterized
// route below. Nothing is registered on a core-only build.
mountRoutes(app, 'files')

// =============================================
// Static routes MUST come before parameterized
// =============================================

// POST /api/files/batch-checkin
app.post(
  '/batch-checkin',
  adapt(
    apiHandler(
      {
        permission: ['documents', 'update'],
        body: batchFileCheckinRequestSchema,
      },
      async ({ body: { fileIds }, user }) => {
        const checkedIn: Array<{ fileId: string; fileName: string }> = []
        const errors: Array<{
          fileId: string
          error: string
          details?: string
        }> = []

        // Process each file
        for (const fileId of fileIds) {
          try {
            // Reach first. A batch is a list of ids from the caller, so
            // without this it was the widest way into the vault: one request
            // could unlock a hundred files across every program.
            const file = await requireFileAccess(fileId, user.id)

            // Checkin the file (unlock without new version)
            await FileService.checkInFile(fileId, user.id)

            checkedIn.push({
              fileId,
              fileName: file.originalFileName,
            })
          } catch (error) {
            const denial = batchDenial(error)
            if (denial) {
              errors.push({ fileId, ...denial })
              continue
            }

            const errorMessage = (error as Error).message

            errors.push({
              fileId,
              error: 'Failed to checkin file',
              details: errorMessage,
            })
          }
        }

        const result: BatchFileCheckinResult = {
          checkedIn,
          errors,
        }

        // Return 207 Multi-Status if there are both successes and errors
        // Return 200 OK if all succeeded
        // Return 400 Bad Request if all failed
        let status = 200
        if (errors.length > 0 && checkedIn.length > 0) {
          status = 207 // Multi-Status
        } else if (errors.length > 0 && checkedIn.length === 0) {
          status = 400
        }

        return jsonResponse(result, status)
      },
    ),
  ),
)

// POST /api/files/batch-checkout
app.post(
  '/batch-checkout',
  adapt(
    apiHandler(
      {
        permission: ['documents', 'update'],
        body: batchFileCheckoutRequestSchema,
      },
      async ({ body: { fileIds }, user }) => {
        const checkedOut: Array<{
          fileId: string
          fileName: string
          checkedOutAt: Date
        }> = []
        const errors: Array<{
          fileId: string
          error: string
          details?: string
        }> = []

        // Process each file
        for (const fileId of fileIds) {
          try {
            const file = await requireFileAccess(fileId, user.id)

            // Checkout the file
            await FileService.checkOutFile(fileId, user.id)

            checkedOut.push({
              fileId,
              fileName: file.originalFileName,
              checkedOutAt: new Date(),
            })
          } catch (error) {
            const denial = batchDenial(error)
            if (denial) {
              errors.push({ fileId, ...denial })
              continue
            }

            const errorMessage = (error as Error).message

            // Parse the error message for better details
            let details: string | undefined
            if (errorMessage.includes('already checked out')) {
              // Extract user info from error message if available
              details = errorMessage
            }

            errors.push({
              fileId,
              error: 'Failed to checkout file',
              details: details || errorMessage,
            })
          }
        }

        const result: BatchFileCheckoutResult = {
          checkedOut,
          errors,
        }

        // Return 207 Multi-Status if there are both successes and errors
        // Return 201 Created if all succeeded
        // Return 400 Bad Request if all failed
        let status = 201
        if (errors.length > 0 && checkedOut.length > 0) {
          status = 207 // Multi-Status
        } else if (errors.length > 0 && checkedOut.length === 0) {
          status = 400
        }

        return jsonResponse(result, status)
      },
    ),
  ),
)

// =============================================
// Parameterized routes with :fileId
// =============================================

// GET /api/files
app.get(
  '/',
  adapt(
    apiHandler(
      { permission: ['documents', 'read'] },
      async ({ request, user }) => {
        // Validated, not parseInt: `limit=abc` used to become NaN and reach the
        // query. The 100 default predates the freeze and is kept — the OpenAPI
        // snapshot is the authority on per-endpoint defaults.
        const { limit } = parseQuery(
          request,
          z.object({
            limit: z.coerce.number().int().min(1).max(500).default(100),
          }),
        )

        // `documents:read` says the caller may read files; it does not say
        // whose. Bound the listing to the designs the caller can reach, the
        // same set `requireFileAccess` enforces on every by-id file route.
        const accessScope = await AccessControlService.getAccessScope(user.id)

        const files = await FileService.listAllFiles({
          limit,
          latestOnly: true,
          includeDeleted: false,
          accessScope,
        })

        return {
          files,
          count: files.length,
        }
      },
    ),
  ),
)

// DELETE /api/files/:fileId
app.delete(
  '/:fileId',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'delete'] },
      async ({ params, user }) => {
        const { fileId } = params

        await requireFileAccess(fileId, user.id)
        await FileService.deleteFile(fileId, user.id)

        return {
          success: true,
          message: 'File deleted successfully',
        }
      },
    ),
  ),
)

// PATCH /api/files/:fileId/category
app.patch(
  '/:fileId/category',
  adapt(
    apiHandler<{ fileId: string }, z.infer<typeof setFileCategorySchema>>(
      {
        body: setFileCategorySchema,
        permission: ['documents', 'update'],
        openapi: {
          summary: "Set or clear a file's category",
          description:
            'Categories are guessed from the filename at upload. Send a category ' +
            "to record a person's answer instead — it is marked manual and nothing " +
            're-detects over it, including a new version uploaded on check-in. Send ' +
            'null to clear the override and fall back to auto-detection.',
          request: {
            params: z.object({ fileId: z.string().uuid() }),
          },
          responses: {
            200: {
              schema: z.object({
                file: z.object({
                  id: z.string().uuid(),
                  fileCategory: z.string().nullable(),
                  categorySource: z.enum(CATEGORY_SOURCES),
                  isPrimaryModel: z.boolean(),
                }),
              }),
            },
          },
        },
      },
      async ({ body, params, user }) => {
        const { fileId } = params

        await requireFileAccess(fileId, user.id)

        const file = await FileService.setFileCategory(
          fileId,
          body.category,
          user.id,
        )

        return { file }
      },
    ),
  ),
)

// POST /api/files/:fileId/checkin
app.post(
  '/:fileId/checkin',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'update'], rateLimit: 'upload' },
      async ({ request, params, user }) => {
        const { fileId } = params

        // Before the multipart read: an unreachable file is a 403, not a
        // rejected upload the caller has already spent bandwidth on.
        await requireFileAccess(fileId, user.id)

        // Check if multipart (new version) or just unlock
        const contentType = request.headers.get('content-type') || ''

        if (contentType.includes('multipart/form-data')) {
          // New version upload
          const formData = await request.formData()
          const file = formData.get('file') as File | null

          if (file) {
            const arrayBuffer = await file.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            const metadata = {
              originalFileName: file.name,
              mimeType: file.type || 'application/octet-stream',
              size: file.size,
              description: formData.get('description')?.toString(),
            }

            const newVersion = await FileService.checkInFile(
              fileId,
              user.id,
              buffer,
              metadata,
            )

            return {
              success: true,
              message: 'File checked in with new version',
              newVersion,
            }
          }
        }

        // Just unlock without new version
        await FileService.checkInFile(fileId, user.id)

        return {
          success: true,
          message: 'File checked in successfully',
        }
      },
    ),
  ),
)

// POST /api/files/:fileId/checkout
app.post(
  '/:fileId/checkout',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'update'] },
      async ({ params, user }) => {
        const { fileId } = params

        await requireFileAccess(fileId, user.id)
        await FileService.checkOutFile(fileId, user.id)

        return {
          success: true,
          message: 'File checked out successfully',
        }
      },
    ),
  ),
)

// POST /api/files/:fileId/convert
app.post(
  '/:fileId/convert',
  adapt(
    apiHandler<
      { fileId: string },
      z.infer<typeof convertInputSchema> | undefined
    >(
      {
        body: convertInputSchema.optional(),
        permission: ['documents', 'read'],
        openapi: {
          summary: 'Queue a CAD file for mesh conversion',
          description:
            'STEP (.step/.stp) and IGES (.iges/.igs) only. Returns 202 with ' +
            'the id of a background job — poll GET /api/v1/jobs/:id for its ' +
            'result; the STL and GLB appear as new files on the target item ' +
            'when it completes. The body is optional: an absent or ' +
            'unparseable one runs on the defaults below.',
          request: {
            params: z.object({ fileId: z.string().uuid() }),
            // The schema comes from `body:` above; this says the body may be
            // omitted altogether, which the option alone cannot express.
            body: { schema: convertInputSchema, required: false },
          },
          responses: {
            202: {
              schema: z.object({ jobId: z.string().uuid() }),
              description: 'Conversion queued',
            },
          },
        },
      },
      async ({ body, params, user }) => {
        const { fileId } = params

        // Fetch the vault file to validate it exists and is a CAD format
        const file = await requireFileAccess(fileId, user.id)

        // Validate file extension is a supported CAD format
        const ext = file.fileName
          .substring(file.fileName.lastIndexOf('.'))
          .toLowerCase()
        if (!CAD_EXTENSIONS.has(ext)) {
          throw new ValidationError(
            `Unsupported file format: ${ext}. Supported formats: STEP (.step/.stp), IGES (.iges/.igs)`,
          )
        }

        // An absent body runs on the schema's own defaults. A body that is
        // present but wrong is now a 400: it used to be swallowed by the same
        // catch that handled "no body at all", so a caller asking for
        // meshQuality: 'ultra' silently got 'standard'.
        const input = body ?? convertInputSchema.parse({})

        // Submit conversion job
        // targetItemId allows directing output to a different item (e.g., STEP on Document -> STL on Part)
        const outputItemId = input.targetItemId ?? file.itemId
        const job = await JobService.submit(
          'conversion.cad.step-to-stl',
          {
            vaultFileId: fileId,
            itemId: outputItemId,
            outputFormat: 'stl',
            meshQuality: input.meshQuality,
            decompose: input.decompose,
            userId: user.id,
          },
          user.id,
          { itemId: outputItemId },
        )

        return new Response(JSON.stringify({ data: { jobId: job.id } }), {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    ),
  ),
)

// GET /api/files/:fileId/download
app.get(
  '/:fileId/download',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId } = params

        const file = await requireFileAccess(fileId, user.id)

        // Use streaming for files larger than 10MB
        if (file.fileSize > 10 * 1024 * 1024) {
          const stream = await FileService.createFileStream(fileId, user.id)

          return new Response(stream, {
            headers: {
              'Content-Type': file.mimeType,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalFileName)}"`,
              'Content-Length': file.fileSize.toString(),
              'X-Content-Type-Options': 'nosniff',
            },
          })
        } else {
          // Download entire file for smaller files
          const data = await FileService.downloadFile(fileId, user.id)

          // Convert Buffer to Uint8Array for Response constructor
          return new Response(new Uint8Array(data), {
            headers: {
              'Content-Type': file.mimeType,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalFileName)}"`,
              'Content-Length': data.length.toString(),
              'X-Content-Type-Options': 'nosniff',
            },
          })
        }
      },
    ),
  ),
)

// GET /api/files/:fileId/content
//
// The same bytes as /download, served for rendering rather than for saving:
// inline disposition, a Content-Type taken from the extension allowlist rather
// than from the caller-supplied mimeType, and a `view` rather than a
// `download` entry in the file's history.
app.get(
  '/:fileId/content',
  adapt(
    apiHandler<{ fileId: string }>(
      {
        permission: ['documents', 'read'],
        openapi: {
          summary: 'Stream a file inline for in-app preview',
          description:
            'Serves the file for rendering in the embedded viewer. Only formats Cascadia can display are served (PDF, raster images, SVG, plain text) and only up to the preview size ceiling for that format; anything else must be downloaded. Logs a `view` action rather than a `download`.',
          request: { params: z.object({ fileId: z.string().uuid() }) },
          responses: {
            200: {
              raw: true,
              mediaType: 'application/octet-stream',
              description:
                'File content, inline. 415 if the format is not previewable, 413 if it exceeds the preview size ceiling.',
            },
          },
        },
      },
      async ({ params, user }) => {
        const { fileId } = params
        const file = await requireFileAccess(fileId, user.id)

        // Trust the extension, not the stored mimeType: the latter is whatever
        // the uploading client asserted, and these bytes are served inline
        // from the app's own origin.
        const format = previewFormatFor(file.originalFileName)
        if (!format) {
          throw new FileTypeNotAllowedError(
            file.originalFileName,
            PREVIEWABLE_EXTENSIONS,
          )
        }

        // No Range support in the storage layer yet, so the viewer pulls the
        // file whole. Past this point downloading is the cheaper path. A few
        // formats cap lower than the global ceiling because their viewer, not
        // the transfer, is what gives out first.
        const maxBytes = maxPreviewBytesFor(format)
        if (file.fileSize > maxBytes) {
          throw new FileTooLargeError(maxBytes, file.fileSize)
        }

        const headers = {
          'Content-Type': format.contentType,
          'Content-Disposition': `inline; filename="${encodeURIComponent(file.originalFileName)}"`,
          'Content-Length': file.fileSize.toString(),
          'X-Content-Type-Options': 'nosniff',
          // Belt and braces if these bytes are ever loaded as a document
          // rather than fetched by the viewer.
          'Content-Security-Policy': "sandbox; default-src 'none'",
        }

        // Use streaming for files larger than 10MB
        if (file.fileSize > 10 * 1024 * 1024) {
          const stream = await FileService.createFileStream(
            fileId,
            user.id,
            'view',
          )
          return new Response(stream, { headers })
        }

        const data = await FileService.downloadFile(fileId, user.id, 'view')
        return new Response(new Uint8Array(data), {
          headers: { ...headers, 'Content-Length': data.length.toString() },
        })
      },
    ),
  ),
)

// ============================================
// Markup
// ============================================

// GET /api/files/:fileId/annotations
app.get(
  '/:fileId/annotations',
  adapt(
    apiHandler<{ fileId: string }>(
      {
        permission: ['documents', 'read'],
        openapi: {
          summary: "List a file's markup",
          request: { params: z.object({ fileId: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        await requireFileAccess(params.fileId, user.id)
        return { annotations: await AnnotationService.list(params.fileId) }
      },
    ),
  ),
)

// POST /api/files/:fileId/annotations
//
// Writing markup needs the owning item's checkout, not just `documents:update`
// — see AnnotationService for why marking up a drawing is an edit to the
// engineering record rather than a personal note.
app.post(
  '/:fileId/annotations',
  adapt(
    apiHandler<{ fileId: string }, z.infer<typeof createAnnotationSchema>>(
      {
        body: createAnnotationSchema,
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Add markup to a file',
          description:
            'Requires the owning item to be checked out to the caller. Responds 409 when it is not, or is checked out by somebody else.',
          request: {
            params: z.object({ fileId: z.string().uuid() }),
          },
        },
      },
      async ({ body: input, params, user }) => {
        // AnnotationService gates on the owning item's checkout, not on who
        // may reach the design it belongs to.
        await requireFileAccess(params.fileId, user.id)
        const annotation = await AnnotationService.create(
          params.fileId,
          input,
          user.id,
        )
        return jsonResponse({ annotation }, 201)
      },
    ),
  ),
)

// PATCH /api/files/:fileId/annotations/:annotationId
app.patch(
  '/:fileId/annotations/:annotationId',
  adapt(
    apiHandler<
      { fileId: string; annotationId: string },
      z.infer<typeof updateAnnotationSchema>
    >(
      {
        body: updateAnnotationSchema,
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Revise markup (author only)',
          request: {
            params: z.object({
              fileId: z.string().uuid(),
              annotationId: z.string().uuid(),
            }),
          },
        },
      },
      async ({ body: input, params, user }) => {
        await requireFileAccess(params.fileId, user.id)
        return {
          annotation: await AnnotationService.update(
            params.annotationId,
            input,
            user.id,
          ),
        }
      },
    ),
  ),
)

// DELETE /api/files/:fileId/annotations/:annotationId
app.delete(
  '/:fileId/annotations/:annotationId',
  adapt(
    apiHandler<{ fileId: string; annotationId: string }>(
      {
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Remove markup',
          request: {
            params: z.object({
              fileId: z.string().uuid(),
              annotationId: z.string().uuid(),
            }),
          },
        },
      },
      async ({ params, user }) => {
        await requireFileAccess(params.fileId, user.id)
        await AnnotationService.delete(params.annotationId, user.id)
        return { deleted: true }
      },
    ),
  ),
)

// ============================================
// Watermarking and signing
// ============================================

// POST /api/files/:fileId/watermark
//
// Dispatches the same job the ECO release hook uses, so a manual stamp
// ("UNCONTROLLED COPY", "FOR REVIEW ONLY") and an automatic one leave
// identical traces in the file history.
app.post(
  '/:fileId/watermark',
  adapt(
    apiHandler<{ fileId: string }, z.infer<typeof watermarkRequestSchema>>(
      {
        body: watermarkRequestSchema,
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Queue a watermark stamp for a PDF attachment',
          request: {
            params: z.object({ fileId: z.string().uuid() }),
          },
        },
      },
      async ({ body: input, params, user }) => {
        // Reach before body, like every other route in this file.
        const file = await requireFileAccess(params.fileId, user.id)

        if (previewFormatFor(file.originalFileName)?.kind !== 'pdf') {
          throw new ValidationError('Only PDF attachments can be watermarked')
        }

        const job = await JobService.submit(
          'document.watermark.apply',
          { ...input, fileIds: [params.fileId], userId: user.id },
          user.id,
          { itemId: file.itemId },
        )

        return jsonResponse({ jobId: job.id, status: job.status }, 202)
      },
    ),
  ),
)

// POST /api/files/:fileId/force-unlock
app.post(
  '/:fileId/force-unlock',
  adapt(
    apiHandler<{ fileId: string }>(
      {
        // Charged in two parts, like POST /items/:id/unlock. The declared
        // tuple is the ordinary write authority over a document's files; the
        // instance-admin override below is charged only when this call
        // actually evicts someone. The route used to declare
        // `['documents', 'manage']`, which no seeded role holds — `manage`
        // appears on no item-type resource in ROLE_DEFINITIONS, and an API
        // key cannot acquire it either, since key scopes only narrow — so it
        // answered 403 to everyone, Administrator included.
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Release a file checkout lock held by another user',
          description:
            'Requires documents:update, plus system:manage when the lock belongs to someone else. Releasing a lock you hold yourself is an ordinary check-in and needs no override.',
          request: {
            params: z.object({ fileId: z.string().uuid() }),
          },
        },
      },
      async ({ params, request, user }) => {
        const { fileId } = params

        // The declared tuple is authority over a document's files, not over
        // other programs' files — keep both.
        const file = await requireFileAccess(fileId, user.id)

        if (!file.isCheckedOut) {
          return { success: true, message: 'File is not checked out' }
        }

        if (file.checkedOutBy !== user.id) {
          // Breaking another user's lock discards whatever they had in
          // progress, which is the same instance-admin override that
          // POST /items/:id/unlock charges to evict an item's holder. The
          // ordinary release is POST /:fileId/checkin, holder-only in
          // FileService.checkInFile; this route exists to override that.
          //
          // Deliberately below the "not checked out" early return, so a
          // caller that merely loses a race to another release keeps its 200
          // instead of being turned into a 403.
          await requirePermission(request, 'system', 'manage')
        }

        await FileService.forceReleaseLock(
          fileId,
          user.id,
          'admin-force-unlock',
        )

        return { success: true, message: 'File lock released by admin' }
      },
    ),
  ),
)

// GET /api/files/:fileId/lock-status
app.get(
  '/:fileId/lock-status',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId } = params

        try {
          await requireFileAccess(fileId, user.id)

          const status = await FileService.getFileLockStatus(fileId)
          return status
        } catch (error) {
          if (error instanceof Error && error.message === 'File not found') {
            throw new NotFoundError('File', fileId)
          }
          throw error
        }
      },
    ),
  ),
)

// GET /api/files/:fileId/metadata
app.get(
  '/:fileId/metadata',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId } = params

        const file = await requireFileAccess(fileId, user.id)

        return { file }
      },
    ),
  ),
)

// GET /api/files/:fileId/thumbnail
app.get(
  '/:fileId/thumbnail',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId } = params

        // The parent is the boundary: a thumbnail belongs to the same item,
        // so reaching one is reaching the other.
        const file = await requireFileAccess(fileId, user.id)

        if (!file.thumbnailFileId) {
          return new Response(null, { status: 404 })
        }

        const thumbnailFile = await FileService.getFileMetadata(
          file.thumbnailFileId,
        )
        if (!thumbnailFile) {
          return new Response(null, { status: 404 })
        }

        const data = await FileService.downloadFile(
          file.thumbnailFileId,
          user.id,
        )

        return new Response(new Uint8Array(data), {
          headers: {
            'Content-Type': 'image/png',
            'Content-Length': data.length.toString(),
            'Cache-Control': 'public, max-age=86400',
            'X-Content-Type-Options': 'nosniff',
          },
        })
      },
    ),
  ),
)

// GET /api/files/:fileId/versions
app.get(
  '/:fileId/versions',
  adapt(
    apiHandler<{ fileId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId } = params

        await requireFileAccess(fileId, user.id)

        try {
          const versions = await FileService.listFileVersions(fileId)

          return {
            versions,
            totalVersions: versions.length,
          }
        } catch (error) {
          if (error instanceof Error && error.message === 'File not found') {
            throw new NotFoundError('File', fileId)
          }
          throw error
        }
      },
    ),
  ),
)

// GET /api/files/:fileId/versions/:version/download
app.get(
  '/:fileId/versions/:version/download',
  adapt(
    apiHandler<{ fileId: string; version: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId, version } = params

        await requireFileAccess(fileId, user.id)

        const versionNumber = parseInt(version, 10)
        if (isNaN(versionNumber) || versionNumber < 1) {
          throw new ValidationError('Invalid version number')
        }

        // Get file metadata for this version
        let file: Awaited<ReturnType<typeof FileService.getFileByVersion>>
        try {
          file = await FileService.getFileByVersion(fileId, versionNumber)
        } catch (error) {
          if (error instanceof Error && error.message === 'File not found') {
            throw new NotFoundError('File', fileId)
          }
          if (
            error instanceof Error &&
            error.message === 'File version not found'
          ) {
            throw new NotFoundError(
              'File version',
              `${fileId}@v${versionNumber}`,
            )
          }
          throw error
        }

        if (!file) {
          throw new NotFoundError('File version', `${fileId}@v${versionNumber}`)
        }

        // Use streaming for files larger than 10MB
        if (file.fileSize > 10 * 1024 * 1024) {
          const { stream } = await FileService.createFileVersionStream(
            fileId,
            versionNumber,
            user.id,
          )

          return new Response(stream, {
            headers: {
              'Content-Type': file.mimeType,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalFileName)}"`,
              'Content-Length': file.fileSize.toString(),
              'X-Content-Type-Options': 'nosniff',
              'X-File-Version': versionNumber.toString(),
            },
          })
        } else {
          // Download entire file for smaller files
          const data = await FileService.downloadFileVersion(
            fileId,
            versionNumber,
            user.id,
          )

          return new Response(new Uint8Array(data), {
            headers: {
              'Content-Type': file.mimeType,
              'Content-Disposition': `attachment; filename="${encodeURIComponent(file.originalFileName)}"`,
              'Content-Length': data.length.toString(),
              'X-Content-Type-Options': 'nosniff',
              'X-File-Version': versionNumber.toString(),
            },
          })
        }
      },
    ),
  ),
)

export default app
