import { Hono } from 'hono'
import { tagged } from '../adapter'
import { MbomService } from '@/lib/services/MbomService'
import { DesignService } from '@/lib/services/DesignService'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { requireDesignAccess } from '@/lib/auth/access'
import { apiHandler, created } from '@/lib/api/handler'

const adapt = tagged('MBOM')

const app = new Hono()

// POST /api/mbom
app.post(
  '/',
  adapt(
    apiHandler(
      { permission: ['designs', 'create'] },
      async ({ request, user }) => {
        const data = await request.json()

        // Verify user has access to the source design
        await requireDesignAccess(user.id, data.sourceDesignId)

        const result = await MbomService.createFromEbom(data, user.id)

        return created(result)
      },
    ),
  ),
)

// GET /api/mbom/:designId/upstream-changes
app.get(
  '/:designId/upstream-changes',
  adapt(
    apiHandler({}, async ({ params, user }) => {
      const { designId } = params

      // Verify design exists and is a Manufacturing design
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      if (design.designType !== 'Manufacturing') {
        throw new ValidationError('Design is not a Manufacturing design')
      }

      // Verify user has access to the design
      await requireDesignAccess(user.id, designId)

      const changes = await MbomService.getPendingUpstreamChanges(designId)

      return { changes }
    }),
  ),
)

// POST /api/mbom/:designId/upstream-changes/:id/review
app.post(
  '/:designId/upstream-changes/:id/review',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const { designId, id } = params

      // Verify design exists and is a Manufacturing design
      const design = await DesignService.getById(designId)
      if (!design) {
        throw new NotFoundError('Design', designId)
      }

      if (design.designType !== 'Manufacturing') {
        throw new ValidationError('Design is not a Manufacturing design')
      }

      // Verify user has access to the design
      await requireDesignAccess(user.id, designId)

      const data = await request.json()
      const result = await MbomService.reviewUpstreamChange(id, data, user.id)

      return result
    }),
  ),
)

export default app
