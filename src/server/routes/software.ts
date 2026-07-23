import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { Software } from '@/lib/items/types/software'
import type { VersionContext } from '@/lib/services/VersionResolver'
import { ItemService } from '@/lib/items/services/ItemService'
import { SoftwareSourceService } from '@/lib/services/SoftwareSourceService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Software')

const app = new Hono()

const softwareIdParamSchema = z.object({ id: z.string().uuid() })

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
      async ({ params }) => {
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
        openapi: {
          summary: 'Update a software item',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, request, user }) => {
        const data = await request.json()
        const sw = await ItemService.update<Software>(params.id, data, user.id)
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
      async ({ params }) => {
        await ItemService.delete(params.id)
        return { success: true }
      },
    ),
  ),
)

// GET /api/v1/software/:id/tree - source tree at an optional version context
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
            query: contextQuerySchema,
          },
          responses: {
            200: {
              schema: z.object({
                itemId: z.string(),
                revision: z.string(),
                manifestId: z.string().nullable(),
                fileCount: z.number(),
                totalSize: z.number(),
                entries: z.array(manifestEntrySchema),
              }),
            },
          },
        },
      },
      async ({ params, request }) => {
        const query = parseQuery(request, contextQuerySchema)
        const { item, manifest } = await SoftwareSourceService.getTree(
          params.id,
          toVersionContext(query),
        )
        return {
          itemId: item.id,
          revision: item.revision,
          manifestId: item.manifestId ?? null,
          fileCount: manifest?.fileCount ?? 0,
          totalSize: manifest?.totalSize ?? 0,
          entries: manifest?.entries ?? [],
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
      async ({ params, request }) => {
        const query = parseQuery(
          request,
          contextQuerySchema.extend({ path: z.string().min(1) }),
        )
        const { item } = await SoftwareSourceService.getTree(
          params.id,
          toVersionContext(query),
        )
        if (!item.manifestId) {
          throw new NotFoundError('SourceFile', query.path, {
            detail: 'Software item has no source tree',
          })
        }
        const file = await SoftwareSourceService.getFileContent(
          item.manifestId,
          query.path,
        )
        return { file }
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
        openapi: {
          summary: 'Import source files into a software item',
          request: { params: softwareIdParamSchema },
        },
      },
      async ({ params, request, user }) => {
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
      async ({ params, request }) => {
        const query = parseQuery(
          request,
          z.object({ fromItemId: z.string().uuid() }),
        )

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
