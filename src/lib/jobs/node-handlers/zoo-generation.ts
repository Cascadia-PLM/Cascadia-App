import type { JobContext, JobHandler } from '../types'
import type {
  ZooGenerationPayload,
  ZooGenerationResult,
} from '../definitions/zoo-generation/types'

export const zooGenerationHandler: JobHandler<
  ZooGenerationPayload,
  ZooGenerationResult
> = {
  type: 'generation.cad.zoo',

  async execute(
    payload: ZooGenerationPayload,
    context: JobContext,
  ): Promise<ZooGenerationResult> {
    const startTime = Date.now()

    await context.log.info('Starting Zoo Text-to-CAD generation', {
      partName: payload.partName,
      itemId: payload.itemId,
    })

    if (context.signal.aborted) throw new Error('Job cancelled')

    await context.updateProgress(5, 'Building CAD prompt...')

    // Build a simple prompt from part name + description
    const { buildCadPrompt } =
      await import('@/lib/cad-generation/prompt-builder')
    const prompt = buildCadPrompt({
      partName: payload.partName,
      partDescription: payload.partDescription,
      interfaces: [],
    })

    await context.updateProgress(10, 'Submitting to Zoo API...')

    // Submit to Zoo and wait for completion
    const { ZooClient } = await import('@/lib/cad-generation/zoo-client')
    const zooClient = new ZooClient()

    const { requestId, stepContent } = await zooClient.generateAndWait(
      prompt,
      'step',
    )

    if (context.signal.aborted) throw new Error('Job cancelled')

    await context.updateProgress(80, 'Uploading STEP file to vault...')

    // Upload the generated STEP file to vault
    const { FileService } = await import('@/lib/vault/services/FileService')

    const fileName = `${payload.partName.replace(/[^a-zA-Z0-9_-]/g, '_')}.step`

    const fileRecord = await FileService.uploadFile({
      itemId: payload.itemId,
      file: stepContent,
      metadata: {
        originalFileName: fileName,
        mimeType: 'application/step',
        size: stepContent.length,
      },
      uploadedBy: payload.userId,
    })

    const generationTimeMs = Date.now() - startTime

    await context.updateProgress(100, 'Generation complete')
    await context.log.info('Zoo CAD generation completed', {
      vaultFileId: fileRecord.id,
      fileName,
      generationTimeMs,
      zooRequestId: requestId,
    })

    return {
      vaultFileId: fileRecord.id,
      fileName,
      zooRequestId: requestId,
      generationTimeMs,
    }
  },
}
