// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import { FileService } from '@/lib/vault/services/FileService'
import { JobService } from '@/lib/jobs/JobService'
import { apiHandler, jsonResponse } from '@/lib/api/handler'
import {
  FileTooLargeError,
  FileTypeNotAllowedError,
  NotFoundError,
  ValidationError,
} from '@/lib/errors'
import { requireDesignAccess, requireFileAccess } from '@/lib/auth/access'
import { mountRoutes } from '@/lib/api/route-registry'
import {
  batchFileCheckinRequestSchema,
  batchFileCheckoutRequestSchema,
} from '@/lib/api/schemas'
import { db } from '@/lib/db'
import { items } from '@/lib/db/schema'
import {
  CATEGORY_SOURCES,
  FILE_CATEGORY_VALUES,
} from '@/lib/vault/file-categories'
import {
  MAX_PREVIEW_BYTES,
  PREVIEWABLE_EXTENSIONS,
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
      { permission: ['documents', 'update'] },
      async ({ request, user }) => {
        // Parse and validate request body
        const body = await request.json()
        const parseResult = batchFileCheckinRequestSchema.safeParse(body)

        if (!parseResult.success) {
          throw ValidationError.fromZodError(parseResult.error)
        }

        const { fileIds } = parseResult.data

        // Limit batch size to prevent abuse
        if (fileIds.length > 100) {
          throw new ValidationError('Batch size limited to 100 files')
        }

        const checkedIn: Array<{ fileId: string; fileName: string }> = []
        const errors: Array<{
          fileId: string
          error: string
          details?: string
        }> = []

        // Process each file
        for (const fileId of fileIds) {
          try {
            // Get file metadata first
            const file = await FileService.getFileMetadata(fileId)
            if (!file) {
              errors.push({
                fileId,
                error: 'File not found',
              })
              continue
            }

            // Checkin the file (unlock without new version)
            await FileService.checkInFile(fileId, user.id)

            checkedIn.push({
              fileId,
              fileName: file.originalFileName,
            })
          } catch (error) {
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
      { permission: ['documents', 'update'] },
      async ({ request, user }) => {
        // Parse and validate request body
        const body = await request.json()
        const parseResult = batchFileCheckoutRequestSchema.safeParse(body)

        if (!parseResult.success) {
          throw ValidationError.fromZodError(parseResult.error)
        }

        const { fileIds } = parseResult.data

        // Limit batch size to prevent abuse
        if (fileIds.length > 100) {
          throw new ValidationError('Batch size limited to 100 files')
        }

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
            // Get file metadata first
            const file = await FileService.getFileMetadata(fileId)
            if (!file) {
              errors.push({
                fileId,
                error: 'File not found',
              })
              continue
            }

            // Checkout the file
            await FileService.checkOutFile(fileId, user.id)

            checkedOut.push({
              fileId,
              fileName: file.originalFileName,
              checkedOutAt: new Date(),
            })
          } catch (error) {
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
    apiHandler({ permission: ['documents', 'read'] }, async ({ request }) => {
      const url = new URL(request.url)
      const limit = parseInt(url.searchParams.get('limit') || '100', 10)

      const files = await FileService.listAllFiles({
        limit,
        latestOnly: true,
        includeDeleted: false,
      })

      return {
        files,
        count: files.length,
      }
    }),
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
    apiHandler<{ fileId: string }>(
      {
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
            body: { schema: setFileCategorySchema },
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
      async ({ request, params, user }) => {
        const { fileId } = params

        const body = await request.json().catch(() => null)
        const parsed = setFileCategorySchema.safeParse(body)
        if (!parsed.success) {
          throw ValidationError.fromZodError(parsed.error)
        }

        const file = await FileService.setFileCategory(
          fileId,
          parsed.data.category,
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
    apiHandler<{ fileId: string }>(
      {
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
      async ({ request, params, user }) => {
        const { fileId } = params

        // Fetch the vault file to validate it exists and is a CAD format
        const file = await FileService.getFileMetadata(fileId)
        if (!file) {
          throw new NotFoundError('File', fileId)
        }

        // Validate file extension is a supported CAD format
        const ext = file.fileName
          .substring(file.fileName.lastIndexOf('.'))
          .toLowerCase()
        if (!CAD_EXTENSIONS.has(ext)) {
          throw new ValidationError(
            `Unsupported file format: ${ext}. Supported formats: STEP (.step/.stp), IGES (.iges/.igs)`,
          )
        }

        // Parse optional body parameters
        let input: z.infer<typeof convertInputSchema> = {
          meshQuality: 'standard',
          decompose: false,
        }
        try {
          const body = await request.json()
          input = convertInputSchema.parse(body)
        } catch {
          // Use defaults if no body or invalid body
        }

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

        // Get file metadata first
        const file = await FileService.getFileMetadata(fileId)

        if (!file) {
          throw new NotFoundError('File', fileId)
        }

        // Check design access via file -> item -> design
        if (file.itemId) {
          const item = await db.query.items.findFirst({
            where: eq(items.id, file.itemId),
          })
          if (item?.designId) {
            await requireDesignAccess(user.id, item.designId)
          }
        }

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
            'Serves the file for rendering in the embedded viewer. Only formats Cascadia can display are served (PDF, raster images, plain text) and only up to the preview size ceiling; anything else must be downloaded. Logs a `view` action rather than a `download`.',
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
        // file whole. Past this point downloading is the cheaper path.
        if (file.fileSize > MAX_PREVIEW_BYTES) {
          throw new FileTooLargeError(MAX_PREVIEW_BYTES, file.fileSize)
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
    apiHandler<{ fileId: string }>(
      {
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Add markup to a file',
          description:
            'Requires the owning item to be checked out to the caller. Responds 409 when it is not, or is checked out by somebody else.',
          request: {
            params: z.object({ fileId: z.string().uuid() }),
            body: { schema: createAnnotationSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        const input = createAnnotationSchema.parse(await request.json())
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
    apiHandler<{ fileId: string; annotationId: string }>(
      {
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Revise markup (author only)',
          request: {
            params: z.object({
              fileId: z.string().uuid(),
              annotationId: z.string().uuid(),
            }),
            body: { schema: updateAnnotationSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        const input = updateAnnotationSchema.parse(await request.json())
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
    apiHandler<{ fileId: string }>(
      {
        permission: ['documents', 'update'],
        openapi: {
          summary: 'Queue a watermark stamp for a PDF attachment',
          request: {
            params: z.object({ fileId: z.string().uuid() }),
            body: { schema: watermarkRequestSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        const input = watermarkRequestSchema.parse(await request.json())
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
      { permission: ['documents', 'manage'] },
      async ({ params, user }) => {
        const { fileId } = params

        const file = await FileService.getFileMetadata(fileId)
        if (!file) {
          throw new NotFoundError('File', fileId)
        }

        if (!file.isCheckedOut) {
          return { success: true, message: 'File is not checked out' }
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
          // Check design access via file -> item -> design
          const file = await FileService.getFileMetadata(fileId)
          if (!file) throw new NotFoundError('File', fileId)

          if (file.itemId) {
            const item = await db.query.items.findFirst({
              where: eq(items.id, file.itemId),
            })
            if (item?.designId) {
              await requireDesignAccess(user.id, item.designId)
            }
          }

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
      async ({ params }) => {
        const { fileId } = params

        const file = await FileService.getFileMetadata(fileId)

        if (!file) {
          throw new NotFoundError('File', fileId)
        }

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

        const file = await FileService.getFileMetadata(fileId)
        if (!file) {
          throw new NotFoundError('File', fileId)
        }

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
      async ({ params }) => {
        const { fileId } = params

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
