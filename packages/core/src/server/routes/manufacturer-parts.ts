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

const adapt = tagged('ManufacturerParts')

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
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Create a manufacturer part',
          request: { body: { schema: manufacturerPartCreateSchema } },
        },
      },
      async ({ request, user }) => {
        const data = manufacturerPartCreateSchema.parse(await request.json())
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
      async ({ params }) => {
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
    apiHandler<{ masterId: string }>(
      {
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Attach a manufacturer part to a part AML',
          request: {
            params: z.object({ masterId: z.string().uuid() }),
            body: { schema: amlAttachSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        const input = amlAttachSchema.parse(await request.json())
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
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Update an AML mapping (qualification status, preferred)',
          request: {
            params: z.object({ id: z.string().uuid() }),
            body: { schema: amlMappingUpdateSchema },
          },
        },
      },
      async ({ params, request }) => {
        const data = amlMappingUpdateSchema.parse(await request.json())
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
      async ({ params }) => {
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
    apiHandler<{ id: string }>(
      {
        permission: ['parts', 'update'],
        openapi: {
          summary: 'Update a manufacturer part',
          request: {
            params: z.object({ id: z.string().uuid() }),
            body: { schema: manufacturerPartUpdateSchema },
          },
        },
      },
      async ({ params, request, user }) => {
        const data = manufacturerPartUpdateSchema.parse(await request.json())
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
