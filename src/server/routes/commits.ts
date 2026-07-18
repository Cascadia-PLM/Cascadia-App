import { Hono } from 'hono'
import { tagged } from '../adapter'
import { CommitService } from '@/lib/services/CommitService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { NotFoundError } from '@/lib/errors'
import { requireDesignAccess } from '@/lib/auth/access'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { itemListSchema } from '@/lib/api/schemas'

const adapt = tagged('Commits')

const app = new Hono()

// GET /api/commits/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params
      const commit = await CommitService.getById(id)
      if (!commit) throw new NotFoundError('Commit', id)

      await requireDesignAccess(user.id, commit.designId)

      const commitWithAuthor = await CommitService.getWithAuthor(id)
      return {
        commit: commitWithAuthor?.commit,
        author: commitWithAuthor?.author,
      }
    }),
  ),
)

// GET /api/commits/:id/diff
app.get(
  '/:id/diff',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, user }) => {
      const { id } = params
      const commit = await CommitService.getById(id)
      if (!commit) throw new NotFoundError('Commit', id)

      await requireDesignAccess(user.id, commit.designId)

      const diff = await CommitService.getDiff(id)
      return { diff }
    }),
  ),
)

// GET /api/commits/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const { id } = params
      const commit = await CommitService.getById(id)
      if (!commit) throw new NotFoundError('Commit', id)

      await requireDesignAccess(user.id, commit.designId)

      const query = parseQuery(request, itemListSchema)

      const result = await VersionResolver.getItemsAtCommit(id, {
        itemType: query.itemType,
        state: query.state,
        search: query.search,
        includeDeleted: query.includeDeleted,
        limit: query.limit,
        offset: query.offset,
      })

      return { items: result.items, total: result.total }
    }),
  ),
)

export default app
