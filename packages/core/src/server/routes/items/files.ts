// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../../adapter'
import { requirePermission } from '@/lib/auth/server'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { getResourceType } from '@/lib/items/item-type-resources'
import { ItemRelationshipService } from '@/lib/items/services/ItemRelationshipService'
import { ModelVersionService } from '@/lib/services/ModelVersionService'
import { apiHandler, created } from '@/lib/api/handler'
import { requireItemAccess } from '@/lib/auth/access'
import { FileService } from '@/lib/vault/services/FileService'

const adapt = tagged('Items')

const app = new Hono()

const VIEWABLE_CAD_EXTENSIONS = new Set(['stl', 'obj', 'glb', 'gltf'])

function isViewableCAD(fileName: string): boolean {
  const ext = fileName.toLowerCase().split('.').pop()
  return ext !== undefined && VIEWABLE_CAD_EXTENSIONS.has(ext)
}

/**
 * A vault file row as the upload path returns it. Passthrough — the row
 * carries storage and CAD-metadata columns beyond the ones a caller needs.
 */
const vaultFileResponseSchema = z
  .object({
    id: z.string().uuid(),
    itemId: z.string().uuid(),
    branchId: z.string().uuid().nullable(),
    fileName: z.string(),
    originalFileName: z.string(),
    fileSize: z.number(),
    mimeType: z.string(),
    fileHash: z.string().describe('SHA-256 of the stored bytes'),
    fileVersion: z.number().int(),
    isPrimaryModel: z.boolean().nullable(),
    isItemThumbnail: z.boolean(),
  })
  .passthrough()

// =============================================
// Routes with :itemId parameter
// =============================================

// GET /api/items/:itemId/cad-files
app.get(
  '/:itemId/cad-files',
  adapt(
    apiHandler<{ itemId: string }>({}, async ({ request, params, user }) => {
      await requireItemAccess(user.id, params.itemId)
      const { itemId } = params

      const url = new URL(request.url)
      const branchId = url.searchParams.get('branchId') || undefined
      const mainBranchId = url.searchParams.get('mainBranchId') || undefined
      const context = { branchId, mainBranchId }

      // 1. Fetch direct files from this item
      const directFiles = await FileService.listItemFilesAtContext(
        itemId,
        context,
        false,
      )

      const directCADFiles = directFiles
        .filter(
          (f) =>
            f.fileCategory === 'cad_model' && isViewableCAD(f.originalFileName),
        )
        .map((f) => ({
          id: f.id,
          fileName: f.originalFileName,
          fileType: f.originalFileName.toLowerCase().split('.').pop() || '',
          isPrimaryModel: f.isPrimaryModel,
          hasColors: f.cadMetadata?.hasColors ?? false,
          source: 'direct' as const,
          sourceItemId: itemId,
          sourceItemNumber: null as string | null,
        }))

      // 2. Fetch "CAD Doc" relationships to find related Documents
      const relationships =
        await ItemRelationshipService.getRelationshipsWithDetails(
          itemId,
          'CAD Doc',
        )

      // 3. For each related Document, fetch its files
      const relatedCADFiles: Array<{
        id: string
        fileName: string
        fileType: string
        isPrimaryModel: boolean
        hasColors: boolean
        source: 'cad_doc'
        sourceItemId: string
        sourceItemNumber: string | null
      }> = []

      for (const rel of relationships) {
        if (!rel.targetItem) continue

        const docFiles = await FileService.listItemFilesAtContext(
          rel.targetId,
          context,
          false,
        )

        const viewable = docFiles
          .filter(
            (f) =>
              f.fileCategory === 'cad_model' &&
              isViewableCAD(f.originalFileName),
          )
          .map((f) => ({
            id: f.id,
            fileName: f.originalFileName,
            fileType: f.originalFileName.toLowerCase().split('.').pop() || '',
            isPrimaryModel: f.isPrimaryModel,
            hasColors: f.cadMetadata?.hasColors ?? false,
            source: 'cad_doc' as const,
            sourceItemId: rel.targetId,
            sourceItemNumber: rel.targetItem!.itemNumber,
          }))

        relatedCADFiles.push(...viewable)
      }

      const allFiles = [...directCADFiles, ...relatedCADFiles]

      return {
        files: allFiles,
        directCount: directCADFiles.length,
        relatedCount: relatedCADFiles.length,
      }
    }),
  ),
)

const modelVersionFileSchema = z.object({
  id: z.string().uuid(),
  fileName: z.string(),
  fileType: z.string(),
  hasColors: z.boolean(),
  isPrimaryModel: z.boolean(),
  fileSize: z.number(),
  uploadedAt: z.string(),
  source: z.enum(['direct', 'cad_doc']),
  sourceItemId: z.string().uuid(),
  sourceItemNumber: z.string().nullable(),
})

const modelVersionEntrySchema = z.object({
  key: z.string(),
  kind: z.enum(['current', 'branch', 'historical']),
  itemId: z.string().uuid(),
  revision: z.string(),
  state: z.string(),
  modifiedAt: z.string(),
  branch: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      branchType: z.string(),
      changeOrderItemId: z.string().uuid().nullable(),
      changeOrderNumber: z.string().nullable(),
    })
    .nullable(),
  files: z.array(modelVersionFileSchema),
  file: modelVersionFileSchema.nullable(),
})

// GET /api/items/:itemId/model-versions
app.get(
  '/:itemId/model-versions',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        openapi: {
          summary: "List an item's versions with their viewable 3D models",
          description:
            "Enumerates the released version, active branch working versions, and historical revisions of the item's master, each resolved to every viewable CAD model that version context offers — from the version row itself and from the Documents it links as CAD Docs. `files` is ordered so the first entry is the model that context displays by default, which `file` repeats. Powers the 3D comparison overlay on the part detail page.",
          request: { params: z.object({ itemId: z.string().uuid() }) },
          responses: {
            200: {
              schema: z.object({
                versions: z.array(modelVersionEntrySchema),
              }),
            },
          },
        },
      },
      async ({ params, request, user }) => {
        // Two gates where there was one and a half. This route hand-rolled
        // `if (designId) requireDesignAccess(...)` — vacuous on the four types
        // whose `items.design_id` is NULL — and declared no `permission` tuple
        // at all, so `apiHandler`'s RBAC block never ran and a scoped API key
        // had nothing to intersect against. `requireItemAccess` dispatches all
        // four types and ends in the identical design check for the rest; the
        // dispatched read tuple is new here rather than a swap, and is the
        // same one GET /:id charges.
        //
        // The gate also replaces the existence lookup: it returns the very
        // `items` row `ModelVersionService.listForItem` wants, and throws the
        // same `NotFoundError('Item', id)` when there is none.
        const itemRow = await requireItemAccess(user.id, params.itemId)
        await requirePermission(
          request,
          getResourceType(itemRow.itemType),
          'read',
        )

        const versions = await ModelVersionService.listForItem(itemRow)
        return { versions }
      },
    ),
  ),
)

// GET /api/items/:itemId/files
app.get(
  '/:itemId/files',
  adapt(
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'read'] },
      async ({ request, params, user }) => {
        await requireItemAccess(user.id, params.itemId)
        const { itemId } = params

        // Parse query parameters for version context
        const url = new URL(request.url)
        const branchId = url.searchParams.get('branchId') || undefined
        const mainBranchId = url.searchParams.get('mainBranchId') || undefined

        // Use version-context-aware file listing if context provided
        const files = await FileService.listItemFilesAtContext(
          itemId,
          { branchId, mainBranchId },
          false,
        )

        return { files, count: files.length }
      },
    ),
  ),
)

// GET /api/items/:itemId/files/primary
app.get(
  '/:itemId/files/primary',
  adapt(
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.itemId)
        const { itemId } = params

        const file = await FileService.getPrimaryModel(itemId)

        if (!file) {
          return { hasPrimary: false, file: null }
        }

        return { hasPrimary: true, file }
      },
    ),
  ),
)

/** Body of the two designation endpoints below. */
const designateFileSchema = z.object({
  fileId: z
    .string()
    .uuid()
    .describe('A file already uploaded to this item. Must belong to it.'),
})

/** What both designation endpoints return. */
const designateFileResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  fileId: z.string().uuid(),
})

// PUT /api/items/:itemId/files/primary
app.put(
  '/:itemId/files/primary',
  adapt(
    apiHandler<{ itemId: string }, z.infer<typeof designateFileSchema>>(
      {
        body: designateFileSchema,
        openapi: {
          summary: "Designate an item's primary 3D model",
          description:
            'The primary model is the one the 3D viewer opens by default. ' +
            'Designates an already-uploaded file — upload with ' +
            'POST /api/v1/items/:itemId/files/upload first.',
          request: { params: z.object({ itemId: z.string().uuid() }) },
          responses: { 200: { schema: designateFileResponseSchema } },
        },
      },
      async ({ body: { fileId }, params, user }) => {
        await requireItemAccess(user.id, params.itemId)
        const userId = user.id
        const { itemId } = params

        // Verify the file belongs to this item
        const file = await FileService.getFileMetadata(fileId)
        if (!file) {
          throw new NotFoundError('File', fileId)
        }

        if (file.itemId !== itemId) {
          throw new ValidationError('File does not belong to this item')
        }

        await FileService.setPrimaryModel(fileId, userId)

        return {
          success: true,
          message: 'Primary model set successfully',
          fileId,
        }
      },
    ),
  ),
)

// GET /api/items/:itemId/files/thumbnail - which file is the designated thumbnail
app.get(
  '/:itemId/files/thumbnail',
  adapt(
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'read'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.itemId)
        const file = await FileService.getDesignatedThumbnail(params.itemId)

        return { hasThumbnail: file !== null, file }
      },
    ),
  ),
)

// PUT /api/items/:itemId/files/thumbnail - designate an uploaded image as the thumbnail
app.put(
  '/:itemId/files/thumbnail',
  adapt(
    apiHandler<{ itemId: string }, z.infer<typeof designateFileSchema>>(
      {
        body: designateFileSchema,
        permission: ['documents', 'update'],
        openapi: {
          summary: "Designate an uploaded image as the item's thumbnail",
          description:
            'Overrides the thumbnail generated from the CAD model. ' +
            'DELETE the same path to revert to the generated one.',
          request: {
            params: z.object({ itemId: z.string().uuid() }),
          },
          responses: { 200: { schema: designateFileResponseSchema } },
        },
      },
      async ({ body: { fileId }, params, user }) => {
        await requireItemAccess(user.id, params.itemId)
        const { itemId } = params

        // Verify the file belongs to this item
        const file = await FileService.getFileMetadata(fileId)
        if (!file) {
          throw new NotFoundError('File', fileId)
        }

        if (file.itemId !== itemId) {
          throw new ValidationError('File does not belong to this item')
        }

        await FileService.setItemThumbnail(fileId, user.id)

        return {
          success: true,
          message: 'Thumbnail set successfully',
          fileId,
        }
      },
    ),
  ),
)

// DELETE /api/items/:itemId/files/thumbnail - revert to the generated thumbnail
app.delete(
  '/:itemId/files/thumbnail',
  adapt(
    apiHandler<{ itemId: string }>(
      { permission: ['documents', 'update'] },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.itemId)
        await FileService.clearItemThumbnail(params.itemId, user.id)

        return { success: true, message: 'Thumbnail cleared' }
      },
    ),
  ),
)

/**
 * The multipart contract, as a schema.
 *
 * The handler takes every part whose value is a file, whatever it is named,
 * and reads two sibling parts per file by convention. The client sends
 * `file0`, `file1`, … so that is what is named here; `catchall` is what
 * carries the rest, and is the honest description of "any name works".
 */
const fileUploadFormSchema = z
  .object({
    file0: z
      .file()
      .optional()
      .describe('First file. Repeat as file1, file2, …'),
    file0_description: z
      .string()
      .optional()
      .describe('Description stored against `file0`.'),
    file0_isThumbnail: z
      .enum(['true', 'false'])
      .optional()
      .describe('`true` designates `file0` as the item thumbnail.'),
    branchId: z
      .string()
      .uuid()
      .optional()
      .describe(
        'Attach the files in this ECO branch’s version context. Omitted, ' +
          'they attach on main.',
      ),
  })
  .catchall(z.union([z.string(), z.file()]))

// POST /api/items/:itemId/files/upload
app.post(
  '/:itemId/files/upload',
  adapt(
    apiHandler<{ itemId: string }>(
      {
        permission: ['documents', 'update'],
        rateLimit: 'upload',
        openapi: {
          summary: 'Upload one or more files to an item',
          description:
            '`multipart/form-data`. Every part carrying a file is uploaded; ' +
            'the part name is free, and the client uses `file0`, `file1`, ' +
            'and so on. Two optional parts hang off each file part by name: ' +
            '`<name>_description` and `<name>_isThumbnail` (the string `true`). ' +
            'A single `branchId` part applies to the whole request. ' +
            'Uploading a STEP or IGES file does not convert it — call ' +
            'POST /api/v1/files/:fileId/convert with the returned id.',
          request: {
            params: z.object({ itemId: z.string().uuid() }),
            // documented-not-enforced: multipart, not JSON. `body:` reads the
            // request as text and parses it as JSON, which would consume the
            // stream this handler needs for formData().
            body: {
              schema: fileUploadFormSchema,
              mediaType: 'multipart/form-data',
            },
          },
          responses: {
            201: {
              schema: z.object({
                files: z.array(vaultFileResponseSchema),
                count: z.number().int(),
              }),
            },
          },
        },
      },
      async ({ request, params, user }) => {
        await requireItemAccess(user.id, params.itemId)
        const { itemId } = params
        const userId = user.id

        // Parse multipart form data
        const formData = await request.formData()

        // Get branchId from form data (for version context)
        const branchId = formData.get('branchId')?.toString() || undefined

        const uploadedFiles: Array<any> = []

        // Process each file in the form data
        for (const [key, value] of formData.entries()) {
          if (value instanceof File) {
            // Convert File to Buffer
            const arrayBuffer = await value.arrayBuffer()
            const buffer = Buffer.from(arrayBuffer)

            // Get file metadata
            const metadata = {
              originalFileName: value.name,
              mimeType: value.type || 'application/octet-stream',
              size: value.size,
              description: formData.get(`${key}_description`)?.toString(),
            }

            // Upload file with branch context
            const fileRecord = await FileService.uploadFile({
              itemId,
              branchId,
              file: buffer,
              metadata,
              uploadedBy: userId,
              isItemThumbnail:
                formData.get(`${key}_isThumbnail`)?.toString() === 'true',
            })

            uploadedFiles.push(fileRecord)
          }
        }

        if (uploadedFiles.length === 0) {
          throw new ValidationError('No files provided')
        }

        return created({
          files: uploadedFiles,
          count: uploadedFiles.length,
        })
      },
    ),
  ),
)

export default app
