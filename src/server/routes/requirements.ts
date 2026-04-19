import { Hono } from 'hono'
import { z } from 'zod'
import { adapt } from '../adapter'
import type { Requirement } from '@/lib/items/types/requirement'
import { ItemService } from '@/lib/items/services/ItemService'
import { RequirementService } from '@/lib/services/RequirementService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

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
    apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
      const requirement = await ItemService.findById(params.id)
      if (!requirement) throw new NotFoundError('Requirement', params.id)
      return { requirement }
    }),
  ),
)

// PUT /api/requirements/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['parts', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const requirement = await ItemService.update<Requirement>(
          params.id,
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
    apiHandler({ permission: ['parts', 'delete'] }, async ({ params }) => {
      await ItemService.delete(params.id)
      return { success: true }
    }),
  ),
)

// GET /api/requirements/:id/derive
app.get(
  '/:id/derive',
  adapt(
    apiHandler({}, async ({ params }) => {
      const childRequirements = await RequirementService.getChildRequirements(
        params.id,
      )

      return { requirements: childRequirements }
    }),
  ),
)

// POST /api/requirements/:id/derive
app.post(
  '/:id/derive',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const body = await request.json()
      const childData = deriveRequirementSchema.parse(body)

      const derivedRequirement = await RequirementService.deriveRequirement(
        params.id,
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
    apiHandler({}, async ({ params }) => {
      const parentRequirement = await RequirementService.getParentRequirement(
        params.id,
      )

      return { parent: parentRequirement }
    }),
  ),
)

// GET /api/requirements/:id/satisfy
app.get(
  '/:id/satisfy',
  adapt(
    apiHandler({}, async ({ params }) => {
      const satisfyingItems = await RequirementService.getSatisfyingItems(
        params.id,
      )

      return { items: satisfyingItems }
    }),
  ),
)

// POST /api/requirements/:id/satisfy
app.post(
  '/:id/satisfy',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const body = await request.json()
      const { itemIds } = linkSatisfactionSchema.parse(body)

      await RequirementService.linkSatisfaction(params.id, itemIds, user.id)

      return { success: true }
    }),
  ),
)

// DELETE /api/requirements/:id/satisfy
app.delete(
  '/:id/satisfy',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const body = await request.json()
      const { itemId } = unlinkSatisfactionSchema.parse(body)

      await RequirementService.unlinkSatisfaction(params.id, itemId, user.id)

      return { success: true }
    }),
  ),
)

// POST /api/requirements/:id/verify
app.post(
  '/:id/verify',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const body = await request.json()
      const { testCaseIds } = body

      if (!testCaseIds || !Array.isArray(testCaseIds)) {
        throw new ValidationError('testCaseIds array is required')
      }

      await RequirementService.linkVerification(params.id, testCaseIds, user.id)

      return created({ success: true })
    }),
  ),
)

// DELETE /api/requirements/:id/verify
app.delete(
  '/:id/verify',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const testCaseId = url.searchParams.get('testCaseId')

      if (!testCaseId) {
        throw new ValidationError('testCaseId query parameter is required')
      }

      await RequirementService.unlinkVerification(
        params.id,
        testCaseId,
        user.id,
      )

      return { success: true }
    }),
  ),
)

// GET /api/requirements/:id/verifying-tests
app.get(
  '/:id/verifying-tests',
  adapt(
    apiHandler({}, async ({ params }) => {
      const tests = await RequirementService.getVerifyingTests(params.id)

      return { tests }
    }),
  ),
)

export default app
