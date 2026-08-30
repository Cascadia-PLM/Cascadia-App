// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import { tagged } from '../adapter'
import {
  ManufacturerPartService,
  amlAttachSchema,
  amlMappingUpdateSchema,
  manufacturerPartCreateSchema,
  manufacturerPartUpdateSchema,
} from '@/lib/services/ManufacturerPartService'
import { apiHandler, created } from '@/lib/api/handler'
import { requirePartMasterAccess } from '@/lib/auth/access'

const adapt = tagged('ManufacturerParts')

/**
 * Where the program boundary sits on this router.
 *
 * The manufacturer/MPN catalog — `/` and `/:id` — is instance-global, like the
 * standard library: a manufacturer and its part number are facts about the
 * world, not about any one program, and a shared catalog is the point of
 * having one. Those routes stay RBAC-only, deliberately.
 *
 * The AML is not. A mapping says *this design has qualified that source*, which
 * is the design's own commercial information, so the four master-keyed routes
 * below gate on the part's design through `requirePartMasterAccess`. AML rows
 * are master-level and non-versioned, so there is no checkout to demand
 * alongside it — membership is the whole gate.
 */

const app = new Hono()

// GET /api/v1/manufacturer-parts?search=&limit=
app.get(
  '/',
  adapt(
    apiHandler(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: 'Search manufacturer parts',
        },
      },
      async ({ request }) => {
        const url = new URL(request.url, 'http://localhost')
        const search = url.searchParams.get('search') ?? undefined
        const limitRaw = url.searchParams.get('limit')
        const limit = limitRaw ? parseInt(limitRaw, 10) : undefined
        const manufacturerParts = await ManufacturerPartService.search({
          search,
          limit: Number.isNaN(limit) ? undefined : limit,
        })
        return { manufacturerParts }
      },
    ),
  ),
)

// POST /api/v1/manufacturer-parts
app.post(
  '/',
  adapt(
    apiHandler(
      {
        body: manufacturerPartCreateSchema,
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Create a manufacturer part',
        },
      },
      async ({ body: data, user }) => {
        const manufacturerPart = await ManufacturerPartService.create(
          data,
          user.id,
        )
        return created({ manufacturerPart })
      },
    ),
  ),
)

// GET /api/v1/manufacturer-parts/part/:masterId — AML for a part lineage
app.get(
  '/part/:masterId',
  adapt(
    apiHandler<{ masterId: string }>(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: 'List the AML for a part (by master id)',
          request: { params: z.object({ masterId: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        await requirePartMasterAccess(user.id, params.masterId)
        const sources = await ManufacturerPartService.listForPart(
          params.masterId,
        )
        return { sources }
      },
    ),
  ),
)

// POST /api/v1/manufacturer-parts/part/:masterId — attach source to AML
app.post(
  '/part/:masterId',
  adapt(
    apiHandler<{ masterId: string }, z.infer<typeof amlAttachSchema>>(
      {
        body: amlAttachSchema,
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Attach a manufacturer part to a part AML',
          request: {
            params: z.object({ masterId: z.string().uuid() }),
          },
        },
      },
      async ({ body: input, params, user }) => {
        await requirePartMasterAccess(user.id, params.masterId)
        const mapping = await ManufacturerPartService.attach(
          params.masterId,
          input,
          user.id,
        )
        return created({ mapping })
      },
    ),
  ),
)

// PATCH /api/v1/manufacturer-parts/mappings/:id — update qualification/preferred
app.patch(
  '/mappings/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof amlMappingUpdateSchema>>(
      {
        body: amlMappingUpdateSchema,
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Update an AML mapping (qualification status, preferred)',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
        },
      },
      async ({ body: data, params, user }) => {
        const existing = await ManufacturerPartService.getMapping(params.id)
        await requirePartMasterAccess(user.id, existing.partMasterId)
        const mapping = await ManufacturerPartService.updateMapping(
          params.id,
          data,
        )
        return { mapping }
      },
    ),
  ),
)

// DELETE /api/v1/manufacturer-parts/mappings/:id — remove from AML
app.delete(
  '/mappings/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Remove a manufacturer part from a part AML',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params, user }) => {
        const existing = await ManufacturerPartService.getMapping(params.id)
        await requirePartMasterAccess(user.id, existing.partMasterId)
        await ManufacturerPartService.detach(params.id)
        return { success: true }
      },
    ),
  ),
)

// GET /api/v1/manufacturer-parts/:id
app.get(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'read'],
        openapi: {
          summary: 'Get a manufacturer part',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params }) => {
        const manufacturerPart = await ManufacturerPartService.getById(
          params.id,
        )
        return { manufacturerPart }
      },
    ),
  ),
)

// PUT /api/v1/manufacturer-parts/:id
app.put(
  '/:id',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof manufacturerPartUpdateSchema>>(
      {
        body: manufacturerPartUpdateSchema,
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Update a manufacturer part',
          request: {
            params: z.object({ id: z.string().uuid() }),
          },
        },
      },
      async ({ body: data, params, user }) => {
        const manufacturerPart = await ManufacturerPartService.update(
          params.id,
          data,
          user.id,
        )
        return { manufacturerPart }
      },
    ),
  ),
)

// DELETE /api/v1/manufacturer-parts/:id
app.delete(
  '/:id',
  adapt(
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Delete a manufacturer part (cascades AML mappings)',
          request: { params: z.object({ id: z.string().uuid() }) },
        },
      },
      async ({ params }) => {
        await ManufacturerPartService.delete(params.id)
        return { success: true }
      },
    ),
  ),
)

export default app
