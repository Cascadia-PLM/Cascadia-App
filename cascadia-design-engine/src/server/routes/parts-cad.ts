// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Hono } from 'hono'
import { z } from 'zod'
import type { Part } from '@/items/types/part'
import { tagged } from '@/server/adapter'
import { assessPartForCadGeneration } from '@/cad-generation/assessment'
import {
  CAD_GENERATION_DISABLED_MESSAGE,
  resolveCadGenerationSettings,
} from '@/cad-generation/settings'
import { ItemService } from '@/items/services/ItemService'
import { BranchService } from '@/services/BranchService'
import { DesignService } from '@/services/DesignService'
import { JobService } from '@/jobs/JobService'
import { apiHandler, created } from '@/api/handler'

import { requireItemAccess } from '@/auth/access'
import { NotFoundError, ValidationError } from '@/errors'

/**
 * A CAD generation request. The two methods take different inputs — a
 * parametric run needs a template and its parameters, a FreeCAD run works from
 * the part's description — so this is a union on `method` rather than one
 * object of optionals the handler then re-checks.
 */
const generateCadSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('parametric'),
    template: z.string().min(1).max(200),
    parameters: z.record(z.string().max(100), z.number()),
    units: z.enum(['mm', 'in']).optional(),
  }),
  z.object({
    method: z.literal('freecad'),
    template: z.string().max(200).optional(),
    parameters: z.record(z.string().max(100), z.number()).optional(),
    units: z.enum(['mm', 'in']).optional(),
  }),
])

/**
 * Generative CAD actions on a part, contributed to `/api/v1/parts`.
 *
 * These lived in `src/server/routes/parts.ts`, which put generative CAD — and
 * an import of `@/cad-generation` — inside a core route file. Mounted
 * through the route registry, so the URLs and the OpenAPI contract are
 * unchanged; an instance without this package simply has no such endpoints.
 *
 * Paths are declared in full, `:id` included, rather than relying on a nested
 * mount to propagate the parent's path params.
 *
 * The `Parts` tag is kept: they are still operations on a part, and retagging
 * would churn the frozen v1 snapshot for no benefit.
 */
const adapt = tagged('Parts')

const app = new Hono()

/**
 * The program a part belongs to, through its design. The AI provider and its
 * monthly budget resolve per program, so both the assessment and the FreeCAD
 * agent need this rather than falling through to the global settings row.
 */
async function programIdOf(part: Part): Promise<string | undefined> {
  if (!part.designId) return undefined
  const design = await DesignService.getById(part.designId)
  return design?.programId ?? undefined
}

// POST /api/v1/parts/:id/generate-cad
app.post(
  '/:id/generate-cad',
  adapt(
    apiHandler<{ id: string }, z.infer<typeof generateCadSchema>>(
      { body: generateCadSchema },
      async ({ params, body, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        const item = await ItemService.findById(id)
        if (!item) {
          throw new NotFoundError('Part', id)
        }

        const part = item as Part

        if (part.partType !== 'Manufacture') {
          throw new ValidationError(
            'CAD generation is only available for Manufacture parts',
          )
        }

        const { method, template, parameters, units } = body

        // Resolve the branch ID — use item's branchId if set, otherwise
        // look up the main branch for the design
        let branchId = (item as any).branchId as string | null
        if (!branchId && part.designId) {
          const mainBranch = await BranchService.getMainBranch(part.designId)
          branchId = mainBranch?.id ?? null
        }
        if (!branchId) {
          throw new ValidationError('Could not resolve branch for this part')
        }

        let job

        if (method === 'parametric') {
          // The union's parametric arm requires both, so nothing is checked
          // here any more — the 400 names the missing field instead.

          job = await JobService.submit(
            'generation.cad.parametric',
            {
              partTempId: id,
              partName: part.name || part.itemNumber,
              itemId: id,
              branchId,
              userId: user.id,
              spec: {
                shapeTemplate: template,
                parameters,
                units: units || 'mm',
              },
            },
            user.id,
            { priority: 'high', itemId: id },
          )
        } else {
          // Refused here rather than minutes later inside the job: the agent
          // reports the same message, but a queued job that fails at once is
          // a worse answer than a 400 the dialog can show.
          const settings = await resolveCadGenerationSettings()
          if (!settings.enabled) {
            throw new ValidationError(CAD_GENERATION_DISABLED_MESSAGE)
          }

          job = await JobService.submit(
            'generation.cad.ai',
            {
              itemId: id,
              partName: part.name || part.itemNumber,
              partDescription: part.description || part.name || part.itemNumber,
              material: part.material ?? undefined,
              userId: user.id,
              programId: await programIdOf(part),
              branchId,
            },
            user.id,
            { priority: 'normal', itemId: id },
          )
        }

        return created({ jobId: job.id })
      },
    ),
  ),
)

// POST /api/v1/parts/:id/generate-cad/assess
app.post(
  '/:id/generate-cad/assess',
  adapt(
    apiHandler<{ id: string }>({}, async ({ params, request, user }) => {
      const { id } = params
      await requireItemAccess(user.id, id)
      const item = await ItemService.findById(id)
      if (!item) {
        throw new NotFoundError('Part', id)
      }

      const part = item as Part

      // One design lookup so the assessment resolves *this program's* provider
      // config and is gated against *this program's* budget. Without it the
      // call fell through to the global settings row, which is a different
      // instance's answer for a request that named a part.
      const programId = await programIdOf(part)

      const assessment = await assessPartForCadGeneration(
        part.name || part.itemNumber || 'Unknown Part',
        part.description,
        part.partType,
        {
          material: part.material,
          weight: part.weight,
          weightUnit: part.weightUnit,
        },
        // `request.signal` so closing the dialog actually cancels the call.
        // The assessment accepted a signal and no caller supplied one, which
        // left the abort path dead code.
        { userId: user.id, programId, signal: request.signal },
      )

      return assessment
    }),
  ),
)

// POST /api/v1/parts/:id/generate-cad/convert
//
// Submits `conversion.cad.step-to-stl`, which is a *core* job type — STEP/IGES
// conversion is core, only generation is this module's. The endpoint still belongs
// here: it exists to finish the generation flow and nothing else reaches it. A
// module using a core service is the expected direction; the reverse is not.
app.post(
  '/:id/generate-cad/convert',
  adapt(
    apiHandler<{ id: string }, { vaultFileId: string }>(
      { body: z.object({ vaultFileId: z.string().uuid() }) },
      async ({ params, body, user }) => {
        const { id } = params
        await requireItemAccess(user.id, id)
        const item = await ItemService.findById(id)
        if (!item) {
          throw new NotFoundError('Part', id)
        }

        const { vaultFileId } = body

        // Submit conversion job (STEP -> STL/GLB, handled by Python worker)
        const job = await JobService.submit(
          'conversion.cad.step-to-stl',
          {
            vaultFileId,
            itemId: id,
            outputFormat: 'stl',
            meshQuality: 'standard',
            decompose: false,
            userId: user.id,
          },
          user.id,
          { priority: 'high', itemId: id },
        )

        return created({ jobId: job.id })
      },
    ),
  ),
)

export default app
