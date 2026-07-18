import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import type { Requirement } from '@/lib/items/types/requirement'
import { ItemService } from '@/lib/items/services/ItemService'
import { RequirementService } from '@/lib/services/RequirementService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('Requirements')

const deriveRequirementSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  type: z
    .enum([
      'Functional',
      'Non-Functional',
      'Performance',
      'Security',
      'Usability',
      'Business',
    ])
    .optional(),
  priority: z
    .enum(['MustHave', 'ShouldHave', 'CouldHave', 'WontHave'])
    .optional(),
  acceptanceCriteria: z.string().optional(),
  source: z.string().optional(),
  category: z.string().optional(),
})

const linkSatisfactionSchema = z.object({
  itemIds: z.array(z.string().uuid()),
})

const unlinkSatisfactionSchema = z.object({
  itemId: z.string().uuid(),
})

const app = new Hono()

// GET /api/requirements/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'read'] },
      async ({ params }) => {
        const { id } = params
        const requirement = await ItemService.findById(id)
        if (!requirement) throw new NotFoundError('Requirement', id)
        return { requirement }
      },
    ),
  ),
)

// PUT /api/requirements/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const { id } = params
        const requirement = await ItemService.update<Requirement>(
          id,
          data,
          user.id,
        )
        return { requirement }
      },
    ),
  ),
)

// DELETE /api/requirements/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['parts', 'delete'] },
      async ({ params }) => {
        const { id } = params
        await ItemService.delete(id)
        return { success: true }
      },
    ),
  ),
)

// GET /api/requirements/:id/derive
app.get(
  '/:id/derive',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const childRequirements =
        await RequirementService.getChildRequirements(id)

      return { requirements: childRequirements }
    }),
  ),
)

// POST /api/requirements/:id/derive
app.post(
  '/:id/derive',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const body = await request.json()
      const childData = deriveRequirementSchema.parse(body)
      const { id } = params

      const derivedRequirement = await RequirementService.deriveRequirement(
        id,
        {
          ...childData,
          itemType: 'Requirement',
          revision: 'A',
          state: 'Draft',
        },
        user.id,
      )

      return new Response(
        JSON.stringify({ data: { requirement: derivedRequirement } }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      )
    }),
  ),
)

// GET /api/requirements/:id/parent
app.get(
  '/:id/parent',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const parentRequirement =
        await RequirementService.getParentRequirement(id)

      return { parent: parentRequirement }
    }),
  ),
)

// GET /api/requirements/:id/satisfy
app.get(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const satisfyingItems = await RequirementService.getSatisfyingItems(id)

      return { items: satisfyingItems }
    }),
  ),
)

// POST /api/requirements/:id/satisfy
app.post(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const body = await request.json()
      const { itemIds } = linkSatisfactionSchema.parse(body)
      const { id } = params

      await RequirementService.linkSatisfaction(id, itemIds, user.id)

      return { success: true }
    }),
  ),
)

// DELETE /api/requirements/:id/satisfy
app.delete(
  '/:id/satisfy',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const body = await request.json()
      const { itemId } = unlinkSatisfactionSchema.parse(body)
      const { id } = params

      await RequirementService.unlinkSatisfaction(id, itemId, user.id)

      return { success: true }
    }),
  ),
)

// POST /api/requirements/:id/verify
app.post(
  '/:id/verify',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const body = await request.json()
      const { testCaseIds } = body

      if (!testCaseIds || !Array.isArray(testCaseIds)) {
        throw new ValidationError('testCaseIds array is required')
      }

      const { id } = params
      await RequirementService.linkVerification(id, testCaseIds, user.id)

      return created({ success: true })
    }),
  ),
)

// DELETE /api/requirements/:id/verify
app.delete(
  '/:id/verify',
  adapt(
    apiHandler<{ id: string }>({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const testCaseId = url.searchParams.get('testCaseId')

      if (!testCaseId) {
        throw new ValidationError('testCaseId query parameter is required')
      }

      const { id } = params
      await RequirementService.unlinkVerification(id, testCaseId, user.id)

      return { success: true }
    }),
  ),
)

// GET /api/requirements/:id/verifying-tests
app.get(
  '/:id/verifying-tests',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params }) => {
      const { id } = params
      const tests = await RequirementService.getVerifyingTests(id)

      return { tests }
    }),
  ),
)

export default app
