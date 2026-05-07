import { Hono } from 'hono'
import { tagged } from '../adapter'
import { BranchService } from '@/lib/services/BranchService'
import { ProgramService } from '@/lib/services/ProgramService'
import { DesignService } from '@/lib/services/DesignService'
import { CommitService } from '@/lib/services/CommitService'
import { VersionResolver } from '@/lib/services/VersionResolver'
import { NotFoundError, PermissionDeniedError } from '@/lib/errors'
import { requireBranchAccess } from '@/lib/auth/access'
import { apiHandler, parseQuery } from '@/lib/api/handler'
import { itemListSchema } from '@/lib/api/schemas'

const adapt = tagged('Branches')

const app = new Hono()

// GET /api/branches/:id
app.get(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const { branch } = await requireBranchAccess(user.id, params.id)
      return { branch }
    }),
  ),
)

// PUT /api/branches/:id
app.put(
  '/:id',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const branch = await BranchService.getById(params.id)
      if (!branch) throw new NotFoundError('Branch', params.id)

      const design = await DesignService.getById(branch.designId)
      if (!design) throw new NotFoundError('Design', branch.designId)

      // Need lead/admin access to lock/unlock
      if (design.programId) {
        const role = await ProgramService.getUserRole(user.id, design.programId)
        if (role !== 'admin' && role !== 'lead') {
          throw new PermissionDeniedError('branch', 'update')
        }
      }

      const data = await request.json()

      if (data.isLocked === true) {
        await BranchService.lockBranch(params.id)
      } else if (data.isLocked === false) {
        await BranchService.unlockBranch(params.id)
      }

      if (data.isArchived === true) {
        await BranchService.archiveBranch(params.id)
      }

      const updatedBranch = await BranchService.getById(params.id)
      return { branch: updatedBranch }
    }),
  ),
)

// GET /api/branches/:id/commits
app.get(
  '/:id/commits',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      await requireBranchAccess(user.id, params.id)

      const url = new URL(request.url)
      const limit = parseInt(url.searchParams.get('limit') || '50', 10)
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)
      const since = url.searchParams.get('since')
      const until = url.searchParams.get('until')

      const commits = await CommitService.getHistory(params.id, {
        limit,
        offset,
        since: since ? new Date(since) : undefined,
        until: until ? new Date(until) : undefined,
      })

      return { commits }
    }),
  ),
)

// GET /api/branches/:id/items
app.get(
  '/:id/items',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      await requireBranchAccess(user.id, params.id)

      const query = parseQuery(request, itemListSchema)

      const result = await VersionResolver.getBranchItems(params.id, {
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

// GET /api/branches/:id/status
app.get(
  '/:id/status',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      await requireBranchAccess(user.id, params.id)

      const status = await BranchService.getBranchStatus(params.id)
      return { status }
    }),
  ),
)

export default app
