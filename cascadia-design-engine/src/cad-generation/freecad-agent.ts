// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * FreeCAD Script Agent
 *
 * The generative half of CAD generation. The instance's AI provider — the one
 * `loadProviderConfig` resolves for the chatbot and the design engine's
 * drafting stages — writes a FreeCAD Python script for the part, the FreeCAD
 * worker runs it, and the model reads the report and revises until the
 * geometry is valid or the attempt budget is spent. This replaced an external
 * text-to-CAD service: the same model that drafted the BOM now also models the
 * parts, with the engineering context the prompt builder already assembles,
 * and every attempt is inspectable — the script, the traceback, the geometry
 * summary — rather than a black box that took ten minutes to say no.
 *
 * How a run ends:
 *
 * - The model stops calling `run_freecad_script` after a run that reported
 *   `ok`. That is acceptance. The accepted script is executed once more with
 *   `persist: true`: iteration runs write nothing to the vault, so a dozen
 *   attempts leave one STEP behind, not a dozen.
 * - Every attempt failed, or the budget ran out first: a failure carrying the
 *   last report's error, so the stage or the job can say why.
 * - The worker could not run a script at all (nothing consuming the queue,
 *   the job row failed): the stream is torn down at once rather than letting
 *   the model spend tokens retrying against an outage.
 * - The caller aborted.
 *
 * Metering follows `AssemblyPlanner`: the caller owns the `UsageAccumulator`
 * and writes the single usage row for its run, because a stage generating
 * eight parts is one run however many requests it takes.
 */

import { chat, maxIterations, toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import { executeFreecadScript } from './freecad-execute'
import {
  FREECAD_SYSTEM_PROMPT,
  buildFreecadTaskPrompt,
} from './freecad-system-prompt'
import { buildCadPrompt } from './prompt-builder'
import {
  CAD_GENERATION_DISABLED_MESSAGE,
  resolveCadGenerationSettings,
} from './settings'
import type { BoundingBox3D, CadPromptContext } from './types'
import type {
  FreecadGeometrySummary,
  FreecadScriptResult,
} from '@/jobs/definitions/freecad-script/types'
import type { UsageAccumulator } from '@/ai/usage'
import { getAdapter, loadProviderConfig } from '@/ai/adapters'
import {
  isTransientStreamError,
  streamChunkError,
  streamChunkErrorToError,
} from '@/design-engine/stages/stream-error'

/** A line of progress a caller may stream to the user. */
export interface FreecadAgentProgress {
  phase: 'attempt' | 'result' | 'persist' | 'info'
  attempt?: number
  maxAttempts?: number
  text: string
}

/** The seam the executor is injected through; tests substitute a fake. */
export type FreecadScriptExecutor = typeof executeFreecadScript

export interface FreecadAgentOptions {
  promptContext: CadPromptContext
  partName: string
  userId: string
  /** The item the accepted STEP is attached to. */
  itemId: string
  branchId?: string
  /** Resolves the AI provider and budget; the global row when omitted. */
  programId?: string | null
  /** On regeneration: the script that produced the previous geometry. */
  previousScript?: string
  /** Overrides the admin setting. */
  maxIterations?: number
  /** Overrides the admin setting, in milliseconds. */
  scriptTimeoutMs?: number
  signal?: AbortSignal
  /** Owned by the caller, which writes the usage row. */
  usage?: UsageAccumulator
  /** Fires once, before the first request goes out. */
  onProviderResolved?: (resolved: {
    provider: string | null
    model: string | null
  }) => void
  onProgress?: (progress: FreecadAgentProgress) => void
  /** Defaults to the RabbitMQ round trip. */
  execute?: FreecadScriptExecutor
}

export type FreecadAgentResult =
  | {
      success: true
      vaultFileId: string
      fileName: string
      boundingBox?: BoundingBox3D
      /** The accepted script. */
      script: string
      /** Attempts spent, the accepted one included. */
      iterations: number
      /** The model's closing remark, if it made one. */
      summary?: string
    }
  | {
      success: false
      errorMessage: string
      iterations: number
      /** The last script tried, for the failure's audit trail. */
      lastScript?: string
    }

/** How many times one request is retried after a transient provider failure. */
const MAX_TRANSIENT_RETRIES = 2
/** A script's stdout/stderr is returned to the model from the tail only. */
const TOOL_OUTPUT_TAIL_CHARS = 2000
const TRACEBACK_TAIL_LINES = 30
/** Scripts are a few hundred lines at most; the summary a sentence. */
const MAX_TOKENS = 16384

interface Attempt {
  script: string
  report: FreecadScriptResult
}

/**
 * Everything the tool callback mutates. One object rather than a handful of
 * `let`s because TypeScript's flow analysis cannot see assignments made from
 * inside a callback, and would read each of them as never assigned.
 */
interface AgentRunState {
  attempts: number
  lastSuccess: Attempt | null
  lastFailure: Attempt | null
  infrastructureError: Error | null
  /** The active attempt's controller, so the tool can end the stream. */
  controller: AbortController | null
}

const geometryForModelSchema = z.object({
  solidCount: z.number(),
  faceCount: z.number(),
  edgeCount: z.number(),
  volumeMm3: z.number(),
  surfaceAreaMm2: z.number(),
  isValid: z.boolean(),
  boundingBox: z.object({
    minX: z.number(),
    minY: z.number(),
    minZ: z.number(),
    maxX: z.number(),
    maxY: z.number(),
    maxZ: z.number(),
  }),
  size: z.object({ x: z.number(), y: z.number(), z: z.number() }),
})

const toolOutputSchema = z.object({
  ok: z.boolean(),
  /** False when the call was refused: budget spent, or the worker is down. */
  accepted: z.boolean(),
  attempt: z.number(),
  attemptsRemaining: z.number(),
  geometry: geometryForModelSchema.optional(),
  issues: z.array(z.string()),
  errorMessage: z.string().optional(),
  traceback: z.string().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  guidance: z.string(),
})

type ToolOutput = z.infer<typeof toolOutputSchema>

/**
 * Generate one part's STEP file with the FreeCAD agent.
 *
 * Never throws for a failed generation — that is a result. It does throw when
 * the AI provider rejects the request outright (a 4xx, a missing key), which
 * callers report the way they report any other stage error.
 */
export async function generatePartWithFreecad(
  options: FreecadAgentOptions,
): Promise<FreecadAgentResult> {
  const settings = await resolveCadGenerationSettings()
  if (!settings.enabled) {
    return {
      success: false,
      errorMessage: CAD_GENERATION_DISABLED_MESSAGE,
      iterations: 0,
    }
  }

  const maxAttempts = options.maxIterations ?? settings.maxIterations
  const timeoutMs =
    options.scriptTimeoutMs ?? settings.scriptTimeoutSeconds * 1000
  const execute = options.execute ?? executeFreecadScript
  const progress = (event: FreecadAgentProgress) => options.onProgress?.(event)

  const providerConfig = await loadProviderConfig(
    options.programId ?? undefined,
  )
  options.onProviderResolved?.({
    provider: providerConfig.provider,
    model: providerConfig.model,
  })
  const adapter = getAdapter(providerConfig)

  const run: AgentRunState = {
    attempts: 0,
    lastSuccess: null,
    lastFailure: null,
    infrastructureError: null,
    controller: null,
  }

  /**
   * Run one script and record what happened. Returns null when the script
   * could not be run at all — the worker is unreachable or the caller has
   * gone — after recording the reason, so both the tool and the inline
   * fallback below stop the same way.
   */
  const attempt = async (
    script: string,
    notes?: string,
  ): Promise<FreecadScriptResult | null> => {
    run.attempts++
    const index = run.attempts
    progress({
      phase: 'attempt',
      attempt: index,
      maxAttempts,
      text: `Attempt ${index}/${maxAttempts}: running FreeCAD script (${countLines(script)} lines)${notes ? ` — ${notes}` : ''}`,
    })

    let report: FreecadScriptResult
    try {
      report = await execute({
        script,
        partName: options.partName,
        userId: options.userId,
        persist: false,
        timeoutMs,
        signal: options.signal,
      })
    } catch (error) {
      if (!options.signal?.aborted) {
        run.infrastructureError =
          error instanceof Error ? error : new Error(String(error))
      }
      // Tear the provider request down now: the model cannot fix an outage,
      // and every further turn would be tokens spent finding that out.
      run.controller?.abort()
      return null
    }

    if (report.ok) {
      run.lastSuccess = { script, report }
      progress({
        phase: 'result',
        attempt: index,
        maxAttempts,
        text: `Attempt ${index}/${maxAttempts}: geometry valid — ${describeGeometry(report.geometry)}`,
      })
    } else {
      run.lastFailure = { script, report }
      progress({
        phase: 'result',
        attempt: index,
        maxAttempts,
        text: `Attempt ${index}/${maxAttempts} failed: ${firstLine(summarizeFailure(report))}`,
      })
    }
    return report
  }

  const runScriptTool = toolDefinition({
    name: 'run_freecad_script',
    description:
      'Execute a complete FreeCAD Python script headlessly and report what it built. ' +
      'The script must assign the finished geometry (a Part.Shape solid, or a compound of solids) to a variable named `result`. ' +
      'Returns the exception and traceback if it failed, otherwise the solid count, volume and bounding box of `result`. ' +
      'Nothing is stored until you stop calling this tool after an ok run; the last ok script is the one kept.',
    inputSchema: z.object({
      script: z
        .string()
        .min(1)
        .describe(
          'The whole script, not a diff. FreeCAD, App and Part are pre-imported; import anything else you need at the top.',
        ),
      notes: z
        .string()
        .optional()
        .describe('One line on what changed since the previous attempt.'),
    }),
    outputSchema: toolOutputSchema,
  }).server(async (input): Promise<ToolOutput> => {
    if (run.attempts >= maxAttempts) {
      return {
        ok: false,
        accepted: false,
        attempt: run.attempts,
        attemptsRemaining: 0,
        issues: [],
        guidance: `The attempt budget (${maxAttempts}) is spent. Do not call this tool again; reply with a short summary of the last state.`,
      }
    }

    const report = await attempt(input.script, input.notes)
    if (!report) {
      return {
        ok: false,
        accepted: false,
        attempt: run.attempts,
        attemptsRemaining: maxAttempts - run.attempts,
        issues: [],
        errorMessage: run.infrastructureError?.message ?? 'cancelled',
        guidance:
          'The FreeCAD worker could not run the script. Do not call this tool again; reply with a one-line note that generation could not run.',
      }
    }
    return toolOutput(report, run.attempts, maxAttempts)
  })

  const messages = [
    { role: 'system', content: FREECAD_SYSTEM_PROMPT },
    {
      role: 'user',
      content: buildFreecadTaskPrompt({
        specification: buildCadPrompt(options.promptContext),
        maxAttempts,
        previousScript: options.previousScript,
      }),
    },
  ]

  let finalText = ''
  let sawToolCall = false

  try {
    for (let retry = 0; ; retry++) {
      const abortController = new AbortController()
      run.controller = abortController
      const chainAbort = () => abortController.abort()
      if (options.signal?.aborted) abortController.abort()
      else options.signal?.addEventListener('abort', chainAbort, { once: true })

      let retryTransient = false
      finalText = ''

      try {
        const stream = chat({
          adapter,
          messages,
          tools: [runScriptTool],
          maxTokens: MAX_TOKENS,
          // One iteration per tool round plus the opening and closing turns.
          agentLoopStrategy: maxIterations(maxAttempts + 2),
          abortController,
        } as never) as AsyncIterable<Record<string, unknown>>

        for await (const chunk of stream) {
          if (run.infrastructureError || options.signal?.aborted) {
            abortController.abort()
            break
          }

          options.usage?.observe(
            chunk as {
              type: string
              usage?: { promptTokens: number; completionTokens: number }
            },
          )

          // Adapter errors arrive as terminal error chunks, not throws.
          const chunkError = streamChunkError(chunk)
          if (chunkError?.fatal) {
            if (
              isTransientStreamError(chunkError) &&
              retry < MAX_TRANSIENT_RETRIES
            ) {
              retryTransient = true
              abortController.abort()
              progress({
                phase: 'info',
                text: `AI provider connection dropped (${chunkError.message}); retrying (${retry + 2}/${MAX_TRANSIENT_RETRIES + 1})…`,
              })
              break
            }
            throw streamChunkErrorToError(chunkError)
          }
          if (chunkError) continue

          if (chunk.type === 'tool_call') {
            // Text before a tool call is the model thinking aloud; the
            // summary is whatever it says after the last one.
            sawToolCall = true
            finalText = ''
          } else if (
            chunk.type === 'content' &&
            typeof chunk.delta === 'string'
          ) {
            finalText += chunk.delta
          }
        }
      } finally {
        options.signal?.removeEventListener('abort', chainAbort)
        run.controller = null
      }

      if (retryTransient) continue
      break
    }
  } catch (error) {
    // A provider failure after a valid geometry costs the summary, not the
    // part: the accepted script is already in hand.
    if (!run.lastSuccess) throw error
    progress({
      phase: 'info',
      text: `AI provider failed after a valid geometry (${error instanceof Error ? error.message : String(error)}); keeping the accepted script.`,
    })
  }

  const lastScript = (run.lastSuccess ?? run.lastFailure)?.script
  const fail = (errorMessage: string): FreecadAgentResult => ({
    success: false,
    errorMessage,
    iterations: run.attempts,
    lastScript,
  })

  if (options.signal?.aborted) return fail('Cancelled')

  // A model that answered with a fenced script instead of running it gets the
  // run it meant to ask for — once, and only when nothing else happened.
  if (!sawToolCall && run.attempts === 0 && !run.infrastructureError) {
    const fenced = extractPythonBlock(finalText)
    if (fenced) {
      progress({
        phase: 'info',
        text: 'The model returned a script inline instead of running it; running it once.',
      })
      await attempt(fenced, 'returned inline')
      if (options.signal?.aborted) return fail('Cancelled')
    }
  }

  if (!run.lastSuccess) {
    if (run.infrastructureError) return fail(run.infrastructureError.message)
    const reason = run.lastFailure
      ? summarizeFailure(run.lastFailure.report)
      : run.attempts === 0
        ? 'the model did not produce a runnable FreeCAD script'
        : 'no attempt produced valid geometry'
    return fail(
      `FreeCAD generation failed after ${run.attempts} attempt${run.attempts === 1 ? '' : 's'}: ${reason}`,
    )
  }

  progress({
    phase: 'persist',
    text: 'Exporting the accepted geometry to the vault…',
  })

  let persisted: FreecadScriptResult
  try {
    persisted = await execute({
      script: run.lastSuccess.script,
      partName: options.partName,
      userId: options.userId,
      persist: true,
      itemId: options.itemId,
      branchId: options.branchId,
      timeoutMs,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal?.aborted) return fail('Cancelled')
    return fail(
      `The accepted script could not be stored: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!persisted.ok || !persisted.vaultFileId) {
    return fail(
      `The accepted script failed on the persisting run: ${summarizeFailure(persisted)}`,
    )
  }

  return {
    success: true,
    vaultFileId: persisted.vaultFileId,
    fileName: persisted.fileName ?? defaultFileName(options.partName),
    boundingBox:
      persisted.geometry?.boundingBox ??
      run.lastSuccess.report.geometry?.boundingBox,
    script: run.lastSuccess.script,
    iterations: run.attempts,
    summary: finalText.trim() || undefined,
  }
}

/** The report as the model sees it: trimmed output, rounded numbers, next step. */
function toolOutput(
  report: FreecadScriptResult,
  attempt: number,
  maxAttempts: number,
): ToolOutput {
  const remaining = Math.max(0, maxAttempts - attempt)
  const base = {
    ok: report.ok,
    accepted: true,
    attempt,
    attemptsRemaining: remaining,
    issues: report.issues,
    stdout: tail(report.stdout, TOOL_OUTPUT_TAIL_CHARS) || undefined,
    stderr: tail(report.stderr, TOOL_OUTPUT_TAIL_CHARS) || undefined,
  }

  if (report.ok) {
    return {
      ...base,
      geometry: report.geometry ? geometryForModel(report.geometry) : undefined,
      guidance:
        'The script ran and produced valid geometry. Compare size and volume with the specification. ' +
        'If they match, stop calling tools and reply with your summary; otherwise revise and run again.' +
        (remaining === 0 ? ' No attempts remain: accept this result.' : ''),
    }
  }

  return {
    ...base,
    errorMessage: report.errorMessage,
    traceback: report.traceback
      ? tailLines(report.traceback, TRACEBACK_TAIL_LINES)
      : undefined,
    guidance:
      remaining > 0
        ? `The script failed. Diagnose the cause from the error and issues, fix it, and run again (${remaining} attempt${remaining === 1 ? '' : 's'} left).`
        : 'The script failed and no attempts remain. Do not call this tool again; reply with a short note on what went wrong.',
  }
}

function geometryForModel(
  geometry: FreecadGeometrySummary,
): z.infer<typeof geometryForModelSchema> {
  const bb = geometry.boundingBox
  const round = (value: number, places: number) => Number(value.toFixed(places))
  return {
    solidCount: geometry.solidCount,
    faceCount: geometry.faceCount,
    edgeCount: geometry.edgeCount,
    volumeMm3: round(geometry.volumeMm3, 1),
    surfaceAreaMm2: round(geometry.surfaceAreaMm2, 1),
    isValid: geometry.isValid,
    boundingBox: {
      minX: round(bb.minX, 2),
      minY: round(bb.minY, 2),
      minZ: round(bb.minZ, 2),
      maxX: round(bb.maxX, 2),
      maxY: round(bb.maxY, 2),
      maxZ: round(bb.maxZ, 2),
    },
    size: {
      x: round(bb.maxX - bb.minX, 2),
      y: round(bb.maxY - bb.minY, 2),
      z: round(bb.maxZ - bb.minZ, 2),
    },
  }
}

/** One human line for a progress event. */
export function describeGeometry(geometry?: FreecadGeometrySummary): string {
  if (!geometry) return 'no geometry summary'
  const bb = geometry.boundingBox
  const size = [bb.maxX - bb.minX, bb.maxY - bb.minY, bb.maxZ - bb.minZ]
    .map((d) => d.toFixed(1))
    .join(' × ')
  return `${geometry.solidCount} solid${geometry.solidCount === 1 ? '' : 's'}, ${size} mm, ${Math.round(geometry.volumeMm3).toLocaleString('en-US')} mm³`
}

/** The reason a report is not ok, for messages. */
function summarizeFailure(report: FreecadScriptResult): string {
  return (
    report.errorMessage ??
    report.issues[0] ??
    (report.stderr.trim() ? firstLine(report.stderr.trim()) : 'script failed')
  )
}

/**
 * The first fenced Python block in the model's text, or null. Used only when
 * the model narrated a script instead of calling the tool.
 */
export function extractPythonBlock(text: string): string | null {
  const fence = /```(?:python|py)?[ \t]*\r?\n([\s\S]*?)```/g
  let match: RegExpExecArray | null
  while ((match = fence.exec(text)) !== null) {
    const body = match[1]?.trim() ?? ''
    if (body.includes('result')) return body
  }
  return null
}

function defaultFileName(partName: string): string {
  return `${partName.replace(/[^a-zA-Z0-9_-]/g, '_')}.step`
}

function countLines(script: string): number {
  return script.split(/\r?\n/).length
}

function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0] ?? text
}

function tail(text: string, chars: number): string {
  return text.length <= chars ? text : `…${text.slice(-chars)}`
}

function tailLines(text: string, lines: number): string {
  const all = text.split(/\r?\n/)
  return all.length <= lines ? text : `…\n${all.slice(-lines).join('\n')}`
}
