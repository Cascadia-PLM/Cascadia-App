// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * `generation.cad.ai` — the FreeCAD agent for one existing part.
 *
 * Runs on the Node jobs worker. The part detail page's "Generate CAD" dialog
 * submits this and polls the job, so the handler turns the agent's progress
 * lines into job progress: the attempt counter maps onto the progress bar and
 * every line lands in the job log for the audit trail.
 *
 * Each script attempt is itself a `generation.cad.freecad` job submitted to
 * the FreeCAD worker, so this handler is a client of the job system as much
 * as a handler in it — the same shape the design engine's stage has when it
 * runs inside the app process.
 */

import type { JobContext, JobHandler } from '@/jobs/types'
import type {
  AiGenerationPayload,
  AiGenerationResult,
} from '../definitions/ai-generation/types'

export const aiGenerationHandler: JobHandler<
  AiGenerationPayload,
  AiGenerationResult
> = {
  type: 'generation.cad.ai',

  async execute(
    payload: AiGenerationPayload,
    context: JobContext,
  ): Promise<AiGenerationResult> {
    const startTime = Date.now()

    await context.log.info('Starting AI CAD generation', {
      partName: payload.partName,
      itemId: payload.itemId,
    })

    if (context.signal.aborted) throw new Error('Job cancelled')

    await context.updateProgress(5, 'Preparing the part specification...')

    // Dynamic imports keep the agent (and the DB behind it) out of any bundle
    // that only needs the job's definition.
    const { generatePartWithFreecad } =
      await import('@/cad-generation/freecad-agent')
    const { UsageAccumulator, recordLlmUsage } = await import('@/ai/usage')

    const usage = new UsageAccumulator()
    // Set from a callback, which TS's flow analysis does not see.
    const resolvedRef: {
      current: { provider: string | null; model: string | null } | null
    } = { current: null }

    try {
      const result = await generatePartWithFreecad({
        promptContext: {
          partName: payload.partName,
          partDescription: payload.partDescription,
          material: payload.material,
          interfaces: [],
        },
        partName: payload.partName,
        userId: payload.userId,
        itemId: payload.itemId,
        branchId: payload.branchId,
        programId: payload.programId,
        signal: context.signal,
        usage,
        onProviderResolved: (resolved) => {
          resolvedRef.current = resolved
        },
        onProgress: (event) => {
          void context.log.info(event.text, {
            phase: event.phase,
            attempt: event.attempt,
          })
          // Attempts fill 10–85 %; the persisting run is the last stretch.
          const percent =
            event.phase === 'persist'
              ? 90
              : event.attempt && event.maxAttempts
                ? Math.min(
                    85,
                    10 + Math.round((event.attempt / event.maxAttempts) * 75),
                  )
                : undefined
          if (percent !== undefined) {
            void context.updateProgress(percent, event.text)
          }
        },
      })

      if (!result.success) {
        throw new Error(result.errorMessage)
      }

      const generationTimeMs = Date.now() - startTime

      await context.updateProgress(100, 'Generation complete')
      await context.log.info('AI CAD generation completed', {
        vaultFileId: result.vaultFileId,
        fileName: result.fileName,
        iterations: result.iterations,
        generationTimeMs,
        summary: result.summary,
      })

      return {
        vaultFileId: result.vaultFileId,
        fileName: result.fileName,
        iterations: result.iterations,
        generationTimeMs,
        boundingBox: result.boundingBox,
      }
    } finally {
      // One row for the run, whatever ended it — a failed run still spent
      // the tokens it spent, and these rows are what the monthly budget sums.
      const resolved = resolvedRef.current
      if (resolved) {
        const totals = usage.totals
        await recordLlmUsage({
          userId: payload.userId,
          // Not a chat session — this is a job.
          sessionId: null,
          programId: payload.programId ?? null,
          provider: resolved.provider,
          model: resolved.model,
          inputTokens: totals.inputTokens,
          outputTokens: totals.outputTokens,
          durationMs: Date.now() - startTime,
        })
      }
    }
  },
}
