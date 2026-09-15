// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { Software } from '@/lib/items/types/software'
import type { VersionContext } from '@/lib/services/VersionResolver'
import { items, software } from '@/lib/db/schema'
import { db } from '@/lib/db'
import { ItemService } from '@/lib/items/services/ItemService'
import { SoftwareSourceService } from '@/lib/services/SoftwareSourceService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { softwareUpdateSchema } from '@/lib/api/schemas'
import { requireItemAccess } from '@/lib/auth/access'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Software')

const app = new Hono()

const softwareIdParamSchema = z.object({ id: z.string().uuid() })

// Request bodies. Named rather than inlined in the annotation, because the
// same object now runs: apiHandler validates against it and the document is
// generated from it, so the two cannot say different things.
const saveFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']).optional(),
})

const renameFileSchema = z.object({
  fromPath: z.string().min(1),
  toPath: z.string().min(1),
})

const commitDraftSchema = z.object({ message: z.string().min(1) })

// Version-context query params, priority: commit > tag > branch (matches
// VersionResolver). Omitting all of them reads the item version itself.
const contextQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  commitId: z.string().uuid().optional(),
  tagId: z.string().uuid().optional(),
})

function toVersionContext(query: {
  branchId?: string
  commitId?: string
  tagId?: string
}): VersionContext | undefined {
  if (query.commitId) return { type: 'commit', commitId: query.commitId }
  if (query.tagId) return { type: 'tag', tagId: query.tagId }
  if (query.branchId) return { type: 'branch', branchId: query.branchId }
  return undefined
}

const manifestEntrySchema = z.object({
  path: z.string(),
  hash: z.string(),
  size: z.number(),
})

// GET /api/v1/software/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'read'],
        openapi: {
          summary: 'Get a software item by ID',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const sw = await ItemService.findById(params.id)
        if (!sw || sw.itemType !== 'Software')
          throw new NotFoundError('Software', params.id)
        return { software: sw }
      },
    ),
  ),
)

// PUT /api/v1/software/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'update'],
        access: ({ params, user }) => requireItemAccess(user.id, params.id),
        body: softwareUpdateSchema,
        openapi: {
          summary: 'Update a software item',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, body, user }) => {
        const sw = await ItemService.update<Software>(
          params.id,
          body as Partial<Software>,
          user.id,
        )
        return { software: sw }
      },
    ),
  ),
)

// DELETE /api/v1/software/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'delete'],
        openapi: {
          summary: 'Delete a software item',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        await ItemService.delete(params.id, user.id)
        return { success: true }
      },
    ),
  ),
)

// GET /api/v1/software/:id/tree - source tree at an optional version context.
// draft=true returns the uncommitted draft tree when one exists.
app.get(
  '/:id/tree',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'read'],
        openapi: {
          summary: 'Get the source tree of a software item',
          request: {
            params: softwareIdParamSchema,
            query: contextQuerySchema.extend({
              draft: z.enum(['true', 'false']).optional(),
            }),
          },
          responses: {
            200: {
              schema: z.object({
                itemId: z.string(),
                revision: z.string(),
                manifestId: z.string().nullable(),
                draftManifestId: z.string().nullable(),
                isDraft: z.boolean(),
                fileCount: z.number(),
                totalSize: z.number(),
                entries: z.array(manifestEntrySchema),
              }),
            },
          },
        },
      },
      async ({ params, request, user }) => {
        await requireItemAccess(user.id, params.id)
        const query = parseQuery(
          request,
          contextQuerySchema.extend({
            draft: z.enum(['true', 'false']).optional(),
          }),
        )
        const { item, manifest } = await SoftwareSourceService.getTree(
          params.id,
          toVersionContext(query),
        )

        const useDraft = query.draft === 'true' && !!item.draftManifestId
        const effective = useDraft
          ? await SoftwareSourceService.getManifestById(item.draftManifestId!)
          : manifest

        return {
          itemId: item.id,
          revision: item.revision,
          manifestId: item.manifestId ?? null,
          draftManifestId: item.draftManifestId ?? null,
          isDraft: useDraft,
          fileCount: effective?.fileCount ?? 0,
          totalSize: effective?.totalSize ?? 0,
          entries: effective?.entries ?? [],
        }
      },
    ),
  ),
)

// GET /api/v1/software/:id/file?path=... - one file's content
app.get(
  '/:id/file',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'read'],
        openapi: {
          summary: 'Get a source file from a software item',
          request: {
            params: softwareIdParamSchema,
            query: contextQuerySchema.extend({ path: z.string().min(1) }),
          },
        },
      },
      async ({ params, request, user }) => {
        await requireItemAccess(user.id, params.id)
        const query = parseQuery(
          request,
          contextQuerySchema.extend({
            path: z.string().min(1),
            draft: z.enum(['true', 'false']).optional(),
          }),
        )
        const { item } = await SoftwareSourceService.getTree(
          params.id,
          toVersionContext(query),
        )
        const manifestId =
          query.draft === 'true' && item.draftManifestId
            ? item.draftManifestId
            : item.manifestId
        if (!manifestId) {
          throw new NotFoundError('SourceFile', query.path, {
            detail: 'Software item has no source tree',
          })
        }
        const file = await SoftwareSourceService.getFileContent(
          manifestId,
          query.path,
        )
        return { file }
      },
    ),
  ),
)

// PUT /api/v1/software/:id/file - save one file into the draft tree
app.put(
  '/:id/file',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof saveFileSchema>>(
      {
        body: saveFileSchema,
        permission: ['software', 'update'],
        openapi: {
          summary: 'Save a source file to the draft tree',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ body, params, user }) => {
        // Ahead of the checkout gate, so a caller outside the program gets 403
        // rather than 409 — which should not be their answer.
        await requireItemAccess(user.id, params.id)
        const data = Buffer.from(
          body.content,
          body.encoding === 'base64' ? 'base64' : 'utf8',
        )
        const { item, manifest, path } =
          await SoftwareSourceService.saveFileToDraft(
            params.id,
            body.path,
            data,
            user.id,
          )
        // The stored path, not the requested one: the service normalizes
        // separators and a leading './' before writing the entry, and a
        // caller that reads the file back has to ask for what was written.
        return {
          draftManifestId: manifest.id,
          fileCount: manifest.fileCount,
          itemId: item.id,
          path,
        }
      },
    ),
  ),
)

// DELETE /api/v1/software/:id/file?path=... - delete from the draft tree
app.delete(
  '/:id/file',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'update'],
        openapi: {
          summary: 'Delete a source file from the draft tree',
          request: {
            params: softwareIdParamSchema,
            query: z.object({ path: z.string().min(1) }),
          },
        },
      },
      async ({ params, request, user }) => {
        await requireItemAccess(user.id, params.id)
        const query = parseQuery(request, z.object({ path: z.string().min(1) }))
        const { item, manifest } =
          await SoftwareSourceService.deleteFileFromDraft(
            params.id,
            query.path,
            user.id,
          )
        return {
          draftManifestId: manifest.id,
          fileCount: manifest.fileCount,
          itemId: item.id,
        }
      },
    ),
  ),
)

// POST /api/v1/software/:id/file/rename - rename/move within the draft tree
app.post(
  '/:id/file/rename',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof renameFileSchema>>(
      {
        body: renameFileSchema,
        permission: ['software', 'update'],
        openapi: {
          summary: 'Rename a source file in the draft tree',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ body, params, user }) => {
        await requireItemAccess(user.id, params.id)
        const { item, manifest, path } =
          await SoftwareSourceService.renameFileInDraft(
            params.id,
            body.fromPath,
            body.toPath,
            user.id,
          )
        // The stored destination, not the requested one — see the PUT above.
        return {
          draftManifestId: manifest.id,
          fileCount: manifest.fileCount,
          itemId: item.id,
          path,
        }
      },
    ),
  ),
)

// POST /api/v1/software/:id/commit - promote the draft with a message
app.post(
  '/:id/commit',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof commitDraftSchema>>(
      {
        body: commitDraftSchema,
        permission: ['software', 'update'],
        openapi: {
          summary: 'Commit the draft source tree',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ body, params, user }) => {
        await requireItemAccess(user.id, params.id)
        const { item, manifest } = await SoftwareSourceService.commitDraft(
          params.id,
          body.message,
          user.id,
        )
        return {
          itemId: item.id,
          manifestId: manifest?.id ?? null,
          fileCount: manifest?.fileCount ?? 0,
        }
      },
    ),
  ),
)

// POST /api/v1/software/:id/draft/discard - throw away uncommitted edits
app.post(
  '/:id/draft/discard',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'update'],
        openapi: {
          summary: 'Discard the draft source tree',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const item = await SoftwareSourceService.discardDraft(
          params.id,
          user.id,
        )
        return { itemId: item.id, draftManifestId: null }
      },
    ),
  ),
)

// GET /api/v1/software/:id/blob/:hash - blob content by hash (history diffs)
app.get(
  '/:id/blob/:hash',
  adapt(
    apiHandler<{ id: string; hash: string }>(
      {
        permission: ['software', 'read'],
        openapi: {
          summary: 'Get source blob content by hash',
          request: {
            params: softwareIdParamSchema.extend({
              hash: z.string().regex(/^[a-f0-9]{64}$/),
            }),
          },
        },
      },
      async ({ params, user }) => {
        // Blobs are content-addressed and shared across items, so the software
        // item in the path is the only boundary there is to check.
        await requireItemAccess(user.id, params.id)
        if (!/^[a-f0-9]{64}$/.test(params.hash)) {
          throw new ValidationError('Invalid blob hash')
        }
        const blob = await SoftwareSourceService.getBlob(params.hash)
        return { blob }
      },
    ),
  ),
)

// POST /api/v1/software/:id/files - import source files (multipart)
// Accepts multiple "files" parts whose filenames are relative paths, or a
// single .zip which is expanded. "replace=true" replaces the whole tree.
app.post(
  '/:id/files',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'update'],
        rateLimit: 'upload',
        openapi: {
          summary: 'Import source files into a software item',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, request, user }) => {
        await requireItemAccess(user.id, params.id)
        const contentType = request.headers.get('content-type') || ''
        if (!contentType.includes('multipart/form-data')) {
          throw new ValidationError(
            'Expected multipart/form-data with one or more "files" parts',
          )
        }

        const formData = await request.formData()
        const replace = formData.get('replace')?.toString() === 'true'
        const parts = formData.getAll('files')
        const uploads: Array<{ path: string; data: Buffer }> = []
        for (const part of parts) {
          if (part instanceof File) {
            uploads.push({
              path: part.name,
              data: Buffer.from(await part.arrayBuffer()),
            })
          }
        }

        if (uploads.length === 0) {
          throw new ValidationError('No files provided')
        }

        // A single zip archive expands into a tree import
        const first = uploads[0]
        if (uploads.length === 1 && first && /\.zip$/i.test(first.path)) {
          const result = await SoftwareSourceService.importZip(
            params.id,
            first.data,
            user.id,
            { replace },
          )
          return { import: toImportResponse(result) }
        }

        const result = await SoftwareSourceService.importFiles(
          params.id,
          uploads,
          user.id,
          { replace },
        )
        return { import: toImportResponse(result) }
      },
    ),
  ),
)

// GET /api/v1/software/:id/versions - all versions of this software master
// (for revision compare pickers)
app.get(
  '/:id/versions',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'read'],
        openapi: {
          summary: 'List all versions of a software item',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, user }) => {
        await requireItemAccess(user.id, params.id)
        const item = await ItemService.findById(params.id)
        if (!item || item.itemType !== 'Software') {
          throw new NotFoundError('Software', params.id)
        }
        const versions = await db
          .select({
            id: items.id,
            revision: items.revision,
            state: items.state,
            isCurrent: items.isCurrent,
            modifiedAt: items.modifiedAt,
            manifestId: software.manifestId,
          })
          .from(items)
          .leftJoin(software, eq(software.itemId, items.id))
          .where(eq(items.masterId, item.masterId))
          .orderBy(desc(items.modifiedAt))
        return { versions }
      },
    ),
  ),
)

// GET /api/v1/software/:id/diff?fromItemId=... - manifest diff between two
// item versions of the same software master (e.g. Rev A vs Rev B, or base
// vs ECO working copy). Defaults the "to" side to :id.
app.get(
  '/:id/diff',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['software', 'read'],
        openapi: {
          summary: 'Diff source trees between two software item versions',
          request: {
            params: softwareIdParamSchema,
            query: z.object({ fromItemId: z.string().uuid() }),
          },
        },
      },
      async ({ params, request, user }) => {
        // The item in the path first, before the query is even parsed: whether
        // the caller may see this software does not depend on what they asked
        // to compare it against, and a 400 about a missing `fromItemId` would
        // otherwise confirm the item exists.
        await requireItemAccess(user.id, params.id)

        const query = parseQuery(
          request,
          z.object({ fromItemId: z.string().uuid() }),
        )

        // The other side is a caller-supplied id like any other.
        await requireItemAccess(user.id, query.fromItemId)

        const [from, to] = await Promise.all([
          SoftwareSourceService.getTree(query.fromItemId),
          SoftwareSourceService.getTree(params.id),
        ])

        const changes = await SoftwareSourceService.diffManifests(
          from.item.manifestId ?? null,
          to.item.manifestId ?? null,
        )

        return {
          from: {
            itemId: from.item.id,
            revision: from.item.revision,
            manifestId: from.item.manifestId ?? null,
          },
          to: {
            itemId: to.item.id,
            revision: to.item.revision,
            manifestId: to.item.manifestId ?? null,
          },
          changes,
        }
      },
    ),
  ),
)

function toImportResponse(result: {
  item: Software
  manifest: { id: string; fileCount: number; totalSize: number }
  filesImported: number
  blobsCreated: number
}) {
  return {
    itemId: result.item.id,
    manifestId: result.manifest.id,
    fileCount: result.manifest.fileCount,
    totalSize: result.manifest.totalSize,
    filesImported: result.filesImported,
    blobsCreated: result.blobsCreated,
  }
}

export default app
