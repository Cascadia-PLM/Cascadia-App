import { Hono } from 'hono'
import { tagged } from '../adapter'
import { db } from '@/lib/db'
import { roles } from '@/lib/db/schema/users'
import { apiHandler } from '@/lib/api/handler'

const adapt = tagged('Roles')

const app = new Hono()

// GET /api/roles
app.get(
  '/',
  adapt(
    apiHandler({ permission: ['roles', 'read'] }, async ({ request }) => {
      const url = new URL(request.url)
      const limit = Math.min(
        parseInt(url.searchParams.get('limit') || '100', 10),
        500,
      )
      const offset = parseInt(url.searchParams.get('offset') || '0', 10)

      const allRoles = await db.select().from(roles)
      const paginatedRoles = allRoles.slice(offset, offset + limit)

      return { roles: paginatedRoles, total: allRoles.length }
    }),
  ),
)

export default app
