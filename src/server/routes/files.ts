import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { adapt } from '../adapter'
import { FileService } from '@/lib/vault/services/FileService'
import { JobService } from '@/lib/jobs/JobService'
import { apiHandler, jsonResponse } from '@/lib/api/handler'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { requireDesignAccess } from '@/lib/auth/access'
import {
  batchFileCheckinRequestSchema,
  batchFileCheckoutRequestSchema,
} from '@/lib/api/schemas'
import { db } from '@/lib/db'
import { items } from '@/lib/db/schema'

const CAD_EXTENSIONS = new Set(['.step', '.stp', '.iges', '.igs'])

const convertInputSchema = z.object({
  meshQuality: z.enum(['preview', 'standard', 'high']).default('standard'),
  decompose: z.boolean().default(false),
  targetItemId: z.string().uuid().optional(),
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

// =============================================
// Static routes MUST come before parameterized
// =============================================

// POST /api/files/batch-checkin
app.post(
  '/batch-checkin',
  adapt(
    apiHandler(
      { permission: ['documents', 'update'] },
      async ({ request, user, requestId }) => {
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
      async ({ request, user, requestId }) => {
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
    apiHandler({}, async ({ request }) => {
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
    apiHandler(
      { permission: ['documents', 'delete'] },
      async ({ params, user }) => {
        const { fileId } = params as { fileId: string }

        await FileService.deleteFile(fileId, user.id)

        return {
          success: true,
          message: 'File deleted successfully',
        }
      },
    ),
  ),
)

// POST /api/files/:fileId/checkin
app.post(
  '/:fileId/checkin',
  adapt(
    apiHandler(
      { permission: ['documents', 'update'] },
      async ({ request, params, user }) => {
        const { fileId } = params as { fileId: string }

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
    apiHandler(
      { permission: ['documents', 'update'] },
      async ({ params, user }) => {
        const { fileId } = params as { fileId: string }

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
    apiHandler(
      { permission: ['documents', 'read'] },
      async ({ request, params, user }) => {
        const { fileId } = params as { fileId: string }

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
    apiHandler(
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

// POST /api/files/:fileId/force-unlock
app.post(
  '/:fileId/force-unlock',
  adapt(
    apiHandler(
      { permission: ['documents', 'manage'] },
      async ({ params, user }) => {
        const { fileId } = params as { fileId: string }

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
    apiHandler(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId } = params as { fileId: string }

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
    apiHandler({ permission: ['documents', 'read'] }, async ({ params }) => {
      const { fileId } = params as { fileId: string }

      const file = await FileService.getFileMetadata(fileId)

      if (!file) {
        throw new NotFoundError('File', fileId)
      }

      return { file }
    }),
  ),
)

// GET /api/files/:fileId/thumbnail
app.get(
  '/:fileId/thumbnail',
  adapt(
    apiHandler(
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
    apiHandler({ permission: ['documents', 'read'] }, async ({ params }) => {
      const { fileId } = params as { fileId: string }

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
    }),
  ),
)

// GET /api/files/:fileId/versions/:version/download
app.get(
  '/:fileId/versions/:version/download',
  adapt(
    apiHandler(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        const { fileId, version } = params as {
          fileId: string
          version: string
        }

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
