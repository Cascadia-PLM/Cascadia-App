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
        permission: ['physical_parts', 'create'],
        openapi: {
          summary:
            'Register a physical instance (find-or-create by part + serial/lot)',
          request: { body: { schema: physicalPartRegisterSchema } },
        },
      },
      async ({ request, user }) => {
        const input = physicalPartRegisterSchema.parse(await request.json())
        const result = await PhysicalPartService.register(input, user.id)
        // 201 even for idempotent hits — `created` in the body disambiguates.
        return created(result)
      },
    ),
  ),
)

// GET /api/v1/physical-parts?q=&partMasterId=&kind=&state=&limit=
app.get(
  '/',
  adapt(
    apiHandler(
      {
        permission: ['physical_parts', 'read'],
        openapi: { summary: 'Search physical parts (units and lots)' },
      },
      async ({ request }) => {
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
          limit: Number.isNaN(limit) ? undefined : limit,
        })
        return { physicalParts }
      },
    ),
  ),
)

// GET /api/v1/physical-parts/recall?serialNumber=&lotNumber=&partMasterId=
// Registered before '/:id' so the static segment wins.
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
      async ({ request }) => {
        const url = new URL(request.url, 'http://localhost')
        const results = await GenealogyService.recall({
          serialNumber: url.searchParams.get('serialNumber') ?? undefined,
          lotNumber: url.searchParams.get('lotNumber') ?? undefined,
          partMasterId: url.searchParams.get('partMasterId') ?? undefined,
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
      async ({ params }) => {
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
      async ({ params }) => {
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
      async ({ params }) => {
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
    apiHandler<{ id: string }>(
      {
        permission: ['physical_parts', 'update'],
        openapi: {
          summary:
            "Assert that this instance's documents evidence a requirement",
          request: { body: { schema: addEvidenceSchema } },
        },
      },
      async ({ params, request, user }) => {
        const { requirementId, note } = addEvidenceSchema.parse(
          await request.json(),
        )
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
      async ({ params }) => {
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
      async ({ params }) => {
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
    apiHandler<{ id: string }>(
      {
        permission: ['physical_parts', 'update'],
        openapi: {
          summary: 'Update a physical part (state, notes, source, ERP ref)',
          request: {
            params: z.object({ id: z.string().uuid() }),
            body: { schema: physicalPartUpdateSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        const data = physicalPartUpdateSchema.parse(await request.json())
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
