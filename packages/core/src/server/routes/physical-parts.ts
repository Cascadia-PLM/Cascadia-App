// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import {
  PhysicalPartService,
  physicalPartRegisterSchema,
} from '@/lib/services/PhysicalPartService'
import { GenealogyService } from '@/lib/services/GenealogyService'
import {
  QualificationService,
  addEvidenceSchema,
} from '@/lib/services/QualificationService'
import { ItemService } from '@/lib/items/services/ItemService'
import { LifecycleService } from '@/lib/services/LifecycleService'
import { ThreadComparisonService } from '@/lib/services/ThreadComparisonService'
import { NotFoundError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import {
  requirePartMasterAccess,
  requirePhysicalPartAccess,
} from '@/lib/auth/access'
import '@/lib/items/registerItemTypes.server'

const adapt = tagged('PhysicalParts')

const app = new Hono()

const physicalPartUpdateSchema = z.object({
  name: z.string().max(500).optional(),
  state: z.string().max(50).optional(),
  manufacturerPartId: z.string().uuid().nullable().optional(),
  erpRef: z.string().max(200).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
})

// POST /api/v1/physical-parts/register — find-or-create by identity
app.post(
  '/register',
  adapt(
    apiHandler(
      {
        body: physicalPartRegisterSchema,
        permission: ['physical_parts', 'create'],
        openapi: {
          summary:
            'Register a physical instance (find-or-create by part + serial/lot)',
        },
      },
      async ({ body: input, user }) => {
        // Naming a part master is a read of it, and this route answers about it
        // three ways before it writes anything: NotFoundError if the lineage
        // does not exist, ValidationError naming the part's number and its
        // trackingMode if it does but disagrees, and 201 echoing the part's
        // name if it agrees. `physical_parts:create` alone therefore turned a
        // guessed master id into readable part data, and registered a serial
        // against a lineage in a program the caller cannot reach.
        //
        // The gate belongs here and not in `PhysicalPartService.register`:
        // `WorkOrderMaterialService` and `InstructionExecutionService` both call
        // that method internally, after `requireWorkOrderAccess` has already
        // decided the question, and must not acquire a second one.
        await requirePartMasterAccess(user.id, input.partMasterId)
        const result = await PhysicalPartService.register(input, user.id)
        // 201 even for idempotent hits — `created` in the body disambiguates.
        return created(result)
      },
    ),
  ),
)

// GET /api/v1/physical-parts?q=&partMasterId=&kind=&state=&limit=
//
// The index, bounded by the caller's designs. Every parameter above is a user
// filter, so omitting all of them has to mean "everything you may read" and
// never "everything" — the read verb narrows nothing here, since all five
// seeded roles carry `physical_parts:read`.
//
// Naming a `partMasterId` is deliberately *not* pre-checked with
// `requirePartMasterAccess` the way `GET /api/v1/work-orders` pre-checks a
// named `programId`. The predicate already returns an empty list for an
// unreachable lineage, and a 403 would answer that the master exists — turning
// a filter into the existence oracle the scoping is here to remove.
app.get(
  '/',
  adapt(
    apiHandler(
      {
        permission: ['physical_parts', 'read'],
        openapi: { summary: 'Search physical parts (units and lots)' },
      },
      async ({ request, user }) => {
        const url = new URL(request.url, 'http://localhost')
        const kindParam = url.searchParams.get('kind')
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw ? parseInt(limitRaw, 10) : undefined
        const physicalParts = await PhysicalPartService.search({
          q: url.searchParams.get('q') ?? undefined,
          partMasterId: url.searchParams.get('partMasterId') ?? undefined,
          instanceKind:
            kindParam === 'unit' || kindParam === 'lot' ? kindParam : undefined,
          state: url.searchParams.get('state') ?? undefined,
          accessDesignIds: await AccessControlService.getAccessibleDesignIds(
            user.id,
          ),
          limit: Number.isNaN(limit) ? undefined : limit,
        })
        return { physicalParts }
      },
    ),
  ),
)

// GET /api/v1/physical-parts/recall?serialNumber=&lotNumber=&partMasterId=
// Registered before '/:id' so the static segment wins.
//
// Scoped on the same axis as the index above, and in the same change: this is
// the second unscoped list surface on the type, and closing only the first
// would have left the whole disclosure reachable one route over.
app.get(
  '/recall',
  adapt(
    apiHandler(
      {
        permission: ['physical_parts', 'read'],
        openapi: {
          summary:
            'Recall query: end items reachable from matching serials/lots',
        },
      },
      async ({ request, user }) => {
        const url = new URL(request.url, 'http://localhost')
        const results = await GenealogyService.recall({
          serialNumber: url.searchParams.get('serialNumber') ?? undefined,
          lotNumber: url.searchParams.get('lotNumber') ?? undefined,
          partMasterId: url.searchParams.get('partMasterId') ?? undefined,
          accessDesignIds: await AccessControlService.getAccessibleDesignIds(
            user.id,
          ),
        })
        return { results }
      },
    ),
  ),
)

// GET /api/v1/physical-parts/:id/genealogy
app.get(
  '/:id/genealogy',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['physical_parts', 'read'],
        openapi: {
          summary:
            'Derived genealogy (composition + where-used) for a unit/lot',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        await requirePhysicalPartAccess(user.id, params.id)
        return GenealogyService.forPhysicalPart(params.id)
      },
    ),
  ),
)

// GET /api/v1/physical-parts/:id/as-built-comparison
app.get(
  '/:id/as-built-comparison',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['physical_parts', 'read'],
        openapi: {
          summary:
            'As-designed (BOM at the as-built part version) vs as-built (producing WO consumption) for a unit',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        await requirePhysicalPartAccess(user.id, params.id)
        return ThreadComparisonService.compareAsBuilt(params.id)
      },
    ),
  ),
)

// GET /api/v1/physical-parts/:id/evidence — requirement evidence links
app.get(
  '/:id/evidence',
  adapt(
    apiHandler<{ id: string }>(
      { permission: ['physical_parts', 'read'] },
      async ({ params, user }) => {
        await requirePhysicalPartAccess(user.id, params.id)
        const evidence = await QualificationService.listEvidence(params.id)
        return { evidence }
      },
    ),
  ),
)

// POST /api/v1/physical-parts/:id/evidence — assert requirement evidence
app.post(
  '/:id/evidence',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof addEvidenceSchema>>(
      {
        body: addEvidenceSchema,
        permission: ['physical_parts', 'update'],
        openapi: {
          summary:
            "Assert that this instance's documents evidence a requirement",
        },
      },
      async ({ body: { requirementId, note }, params, user }) => {
        await requirePhysicalPartAccess(user.id, params.id)
        const link = await QualificationService.addEvidence(
          params.id,
          requirementId,
          user.id,
          note,
        )
        return created({ link })
      },
    ),
  ),
)

// DELETE /api/v1/physical-parts/:id/evidence/:edgeId
app.delete(
  '/:id/evidence/:edgeId',
  adapt(
    apiHandler<{ id: string; edgeId: string }>(
      { permission: ['physical_parts', 'update'] },
      async ({ params, user }) => {
        await requirePhysicalPartAccess(user.id, params.id)
        await QualificationService.removeEvidence(params.id, params.edgeId)
        return { success: true }
      },
    ),
  ),
)

// GET /api/v1/physical-parts/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['physical_parts', 'read'],
        openapi: {
          summary: 'Get a physical part',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        await requirePhysicalPartAccess(user.id, params.id)
        const physicalPart = await PhysicalPartService.getById(params.id)
        return { physicalPart }
      },
    ),
  ),
)

// PATCH /api/v1/physical-parts/:id — state/notes/erpRef/manufacturer source
app.patch(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof physicalPartUpdateSchema>>(
      {
        body: physicalPartUpdateSchema,
        permission: ['physical_parts', 'update'],
        openapi: {
          summary: 'Update a physical part (state, notes, source, ERP ref)',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
        },
      },
      async ({ body: data, params, user }) => {
        await requirePhysicalPartAccess(user.id, params.id)
        const existing = await ItemService.findById(params.id)
        if (!existing || existing.itemType !== 'PhysicalPart') {
          throw new NotFoundError('PhysicalPart', params.id)
        }
        // State goes through the sanctioned Free-lifecycle transition path
        // (WI-2.1); everything else through the generic item update.
        const { state, ...rest } = data
        if (state && state !== existing.state) {
          await LifecycleService.transitionFreeItem(params.id, state, user.id)
        }
        if (Object.keys(rest).length > 0) {
          await ItemService.update(params.id, rest, user.id)
        }
        const physicalPart = await PhysicalPartService.getById(params.id)
        return { physicalPart }
      },
    ),
  ),
)

export default app
