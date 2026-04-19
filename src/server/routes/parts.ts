import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { adapt } from '../adapter'
import type { Part } from '@/lib/items/types/part'
import { ItemService } from '@/lib/items/services/ItemService'
import { BranchService } from '@/lib/services/BranchService'
import { JobService } from '@/lib/jobs/JobService'
import { VerificationService } from '@/lib/services/VerificationService'
import { ParametricResolutionService } from '@/lib/services/ParametricResolutionService'
import { assessPartForCadGeneration } from '@/lib/cad-generation/assessment'
import { NotFoundError, ValidationError } from '@/lib/errors'
import { apiHandler, created } from '@/lib/api/handler'
import { db } from '@/lib/db'
import {
  items,
  workInstructionPartAttachments,
  workInstructions,
} from '@/lib/db/schema'
// Register item types (server-side version)
import '@/lib/items/registerItemTypes.server'

const app = new Hono()

// GET /api/parts/:id
app.get(
  '/:id',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
      const part = await ItemService.findById(params.id)
      if (!part) throw new NotFoundError('Part', params.id)
      return { part }
    }),
  ),
)

// PUT /api/parts/:id
app.put(
  '/:id',
  adapt(
    apiHandler(
      { permission: ['parts', 'update'] },
      async ({ params, request, user }) => {
        const data = await request.json()
        const part = await ItemService.update<Part>(params.id, data, user.id)
        return { part }
      },
    ),
  ),
)

// DELETE /api/parts/:id
app.delete(
  '/:id',
  adapt(
    apiHandler({ permission: ['parts', 'delete'] }, async ({ params }) => {
      await ItemService.delete(params.id)
      return { success: true }
    }),
  ),
)

// POST /api/parts/:id/generate-cad
app.post(
  '/:id/generate-cad',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Part', params.id)
      }

      const part = item as Part

      if (part.partType !== 'Manufacture') {
        throw new ValidationError(
          'CAD generation is only available for Manufacture parts',
        )
      }

      const body = await request.json()
      const { method, template, parameters, units } = body as {
        method: 'parametric' | 'zoo'
        template?: string
        parameters?: Record<string, number>
        units?: 'mm' | 'in'
      }

      if (!method || !['parametric', 'zoo'].includes(method)) {
        throw new ValidationError('method must be "parametric" or "zoo"')
      }

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
        if (!template || !parameters) {
          throw new ValidationError(
            'template and parameters are required for parametric generation',
          )
        }

        job = await JobService.submit(
          'generation.cad.parametric',
          {
            partTempId: params.id,
            partName: part.name || part.itemNumber,
            itemId: params.id,
            branchId,
            userId: user.id,
            spec: {
              shapeTemplate: template,
              parameters,
              units: units || 'mm',
            },
          },
          user.id,
          { priority: 'high', itemId: params.id },
        )
      } else {
        job = await JobService.submit(
          'generation.cad.zoo',
          {
            itemId: params.id,
            partName: part.name || part.itemNumber,
            partDescription: part.description || part.name || part.itemNumber,
            userId: user.id,
          },
          user.id,
          { priority: 'normal', itemId: params.id },
        )
      }

      return created({ jobId: job.id })
    }),
  ),
)

// POST /api/parts/:id/generate-cad/assess
app.post(
  '/:id/generate-cad/assess',
  adapt(
    apiHandler({}, async ({ params }) => {
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Part', params.id)
      }

      const part = item as Part

      const assessment = await assessPartForCadGeneration(
        part.name || part.itemNumber || 'Unknown Part',
        part.description,
        part.partType,
        {
          material: part.material,
          weight: part.weight,
          weightUnit: part.weightUnit,
        },
      )

      return assessment
    }),
  ),
)

// POST /api/parts/:id/generate-cad/convert
app.post(
  '/:id/generate-cad/convert',
  adapt(
    apiHandler({}, async ({ params, request, user }) => {
      const item = await ItemService.findById(params.id)
      if (!item) {
        throw new NotFoundError('Part', params.id)
      }

      const body = await request.json()
      const { vaultFileId } = body as { vaultFileId: string }

      if (!vaultFileId) {
        throw new ValidationError('vaultFileId is required')
      }

      // Submit conversion job (STEP -> STL/GLB, handled by Python worker)
      const job = await JobService.submit(
        'conversion.cad.step-to-stl',
        {
          vaultFileId,
          itemId: params.id,
          outputFormat: 'stl',
          meshQuality: 'standard',
          decompose: false,
          userId: user.id,
        },
        user.id,
        { priority: 'high', itemId: params.id },
      )

      return created({ jobId: job.id })
    }),
  ),
)

// GET /api/parts/:id/resolvable-attributes
app.get(
  '/:id/resolvable-attributes',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
      const attributes =
        await ParametricResolutionService.getResolvableAttributes(params.id)

      return { attributes }
    }),
  ),
)

// POST /api/parts/:id/validate
app.post(
  '/:id/validate',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const body = await request.json()
      const { testCaseIds } = body

      if (!testCaseIds || !Array.isArray(testCaseIds)) {
        throw new ValidationError('testCaseIds array is required')
      }

      // Link each test case to this part (testCase -> part)
      for (const testCaseId of testCaseIds) {
        await VerificationService.linkValidation(
          testCaseId,
          [params.id],
          user.id,
        )
      }

      return created({ success: true })
    }),
  ),
)

// DELETE /api/parts/:id/validate
app.delete(
  '/:id/validate',
  adapt(
    apiHandler({}, async ({ request, params, user }) => {
      const url = new URL(request.url)
      const testCaseId = url.searchParams.get('testCaseId')

      if (!testCaseId) {
        throw new ValidationError('testCaseId query parameter is required')
      }

      await VerificationService.unlinkValidation(testCaseId, params.id, user.id)

      return { success: true }
    }),
  ),
)

// GET /api/parts/:id/validating-tests
app.get(
  '/:id/validating-tests',
  adapt(
    apiHandler({}, async ({ params }) => {
      const tests = await VerificationService.getValidatingTests(params.id)

      return { tests }
    }),
  ),
)

// GET /api/parts/:id/work-instructions
app.get(
  '/:id/work-instructions',
  adapt(
    apiHandler({ permission: ['parts', 'read'] }, async ({ params }) => {
      // Verify part exists
      const [part] = await db
        .select()
        .from(items)
        .where(eq(items.id, params.id))
        .limit(1)

      if (!part || part.itemType !== 'Part') {
        throw new NotFoundError('Part', params.id)
      }

      // Get work instructions attached to this part
      const attachedWIs = await db
        .select({
          attachmentId: workInstructionPartAttachments.id,
          inheritToMBOM: workInstructionPartAttachments.inheritToMBOM,
          createdAt: workInstructionPartAttachments.createdAt,
          workInstruction: {
            id: items.id,
            itemNumber: items.itemNumber,
            name: items.name,
            revision: items.revision,
            state: items.state,
          },
          workInstructionDetails: {
            description: workInstructions.description,
            estimatedTime: workInstructions.estimatedTime,
            difficulty: workInstructions.difficulty,
          },
        })
        .from(workInstructionPartAttachments)
        .innerJoin(
          items,
          eq(workInstructionPartAttachments.workInstructionId, items.id),
        )
        .innerJoin(
          workInstructions,
          eq(
            workInstructionPartAttachments.workInstructionId,
            workInstructions.itemId,
          ),
        )
        .where(eq(workInstructionPartAttachments.partId, params.id))

      // Flatten the response
      const workInstructionsList = attachedWIs.map((row) => ({
        attachmentId: row.attachmentId,
        inheritToMBOM: row.inheritToMBOM,
        attachedAt: row.createdAt,
        id: row.workInstruction.id,
        itemNumber: row.workInstruction.itemNumber,
        name: row.workInstruction.name,
        revision: row.workInstruction.revision,
        state: row.workInstruction.state,
        description: row.workInstructionDetails.description,
        estimatedTime: row.workInstructionDetails.estimatedTime,
        difficulty: row.workInstructionDetails.difficulty,
      }))

      return { workInstructions: workInstructionsList }
    }),
  ),
)

export default app
