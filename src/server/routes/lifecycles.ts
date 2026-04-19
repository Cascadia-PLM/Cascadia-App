import { Hono } from 'hono'
import { adapt } from '../adapter'
import { apiHandler } from '@/lib/api/handler'
import { LifecycleService } from '@/lib/services/LifecycleService'

const app = new Hono()

// GET /api/lifecycles/by-item-type/:itemType
app.get(
  '/by-item-type/:itemType',
  adapt(
    apiHandler({}, async ({ params }) => {
      const lifecycle = await LifecycleService.getLifecycleForItemType(
        params.itemType,
      )

      if (!lifecycle) {
        return {
          lifecycleId: null,
          name: null,
          phases: [],
          states: [],
          revisionScheme: null,
        }
      }

      return {
        lifecycleId: lifecycle.id,
        name: lifecycle.name,
        phases: lifecycle.phases ?? [],
        states: lifecycle.states,
        revisionScheme: lifecycle.revisionScheme ?? null,
      }
    }),
  ),
)

export default app
