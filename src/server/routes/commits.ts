import { Hono } from 'hono'
import { adapt } from '../adapter'
import { CommitService } from '@/lib/services/CommitService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { NotFoundError } from '@/lib/errors'
import { requireDesignAccess } from '@/lib/auth/access'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { itemListSchema } from '@/lib/api/schemas'

const app = new Hono()

// GET /api/commits/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const commit = await CommitService.getById(params.id)
      if (!commit) throw new NotFoundError('Commit', params.id)

      await requireDesignAccess(user.id, commit.designId)

      const commitWithAuthor = await CommitService.getWithAuthor(params.id)
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
    apiHandler({}, async ({ params, user }) => {
      const commit = await CommitService.getById(params.id)
      if (!commit) throw new NotFoundError('Commit', params.id)

      await requireDesignAccess(user.id, commit.designId)

      const diff = await CommitService.getDiff(params.id)
      return { diff }
    }),
  ),
)

// GET /api/commits/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const commit = await CommitService.getById(params.id)
      if (!commit) throw new NotFoundError('Commit', params.id)

      await requireDesignAccess(user.id, commit.designId)

      const query = parseQuery(request, itemListSchema)

      const result = await VersionResolver.getItemsAtCommit(params.id, {
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
