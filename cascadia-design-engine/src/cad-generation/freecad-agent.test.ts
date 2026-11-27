// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * FreeCAD agent — what ends up in the vault, and when the loop stops.
 *
 * Data-integrity gate: the agent is the only path by which an AI-written
 * script becomes a STEP file on a real part. The invariants held here are
 * that iteration runs never persist, that exactly the accepted script is
 * persisted exactly once, that a later failed attempt does not displace an
 * accepted one, and that the three ways a run can end without geometry — the
 * budget, a worker outage, the caller leaving — persist nothing and say why.
 *
 * The model is a scripted fake: `chat` walks a list of turns, executing the
 * agent's own tool the way the SDK would. The FreeCAD worker is a fake
 * executor injected through the agent's `execute` seam. Nothing here reaches
 * a provider, a broker or a database.
 *
 * Run: npx vitest run cascadia-design-engine/src/cad-generation/freecad-agent.test.ts
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TanStackAi from '@tanstack/ai'
import type { ExecuteFreecadScriptOptions } from './freecad-execute'
import type { FreecadScriptResult } from '@/jobs/definitions/freecad-script/types'
import { UsageAccumulator } from '@/ai/usage'

/** One model turn: either a call of the agent's tool, or plain text. */
type Turn = { tool: { script: string; notes?: string } } | { text: string }

/** The scripted conversation, set per test. */
let turns: Array<Turn> = []
/** Each chat() call's controller, so a test can see the agent tear it down. */
const chatCalls: Array<{ abortController: AbortController }> = []
/** What the tool returned to the (fake) model, in order. */
const toolOutputs: Array<Record<string, unknown>> = []

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  chat: (opts: {
    tools: Array<{
      name: string
      execute: (input: unknown) => Promise<Record<string, unknown>>
    }>
    abortController: AbortController
  }) => {
    chatCalls.push({ abortController: opts.abortController })
    const tool = opts.tools[0]
    if (!tool) throw new Error('the agent registered no tool')
    const script = turns
    return (async function* () {
      let index = 0
      for (const turn of script) {
        // A real stream stops delivering once its request is aborted.
        if (opts.abortController.signal.aborted) return
        if ('tool' in turn) {
          index++
          yield {
            type: 'tool_call',
            toolCall: {
              id: `call-${index}`,
              type: 'function',
              function: {
                name: tool.name,
                arguments: JSON.stringify(turn.tool),
              },
            },
            index,
          }
          const output = await tool.execute(turn.tool)
          toolOutputs.push(output)
          yield {
            type: 'tool_result',
            toolCallId: `call-${index}`,
            content: JSON.stringify(output),
          }
        } else {
          yield { type: 'content', delta: turn.text, content: turn.text }
        }
      }
      yield {
        type: 'done',
        finishReason: 'stop',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      }
    })()
  },
}))

vi.mock('@/ai/adapters', () => ({
  loadProviderConfig: () =>
    Promise.resolve({
      provider: 'anthropic' as const,
      apiKey: 'test-key',
      model: 'claude-opus-5',
    }),
  getAdapter: () => ({}),
}))

const settings = { enabled: true, maxIterations: 3, scriptTimeoutSeconds: 30 }

vi.mock('./settings', () => ({
  resolveCadGenerationSettings: () => Promise.resolve(settings),
  CAD_GENERATION_DISABLED_MESSAGE: 'AI CAD generation is disabled.',
}))

// Imported after the mocks so the factories above are the ones that bind.
const { generatePartWithFreecad } = await import('./freecad-agent')

const VAULT_FILE_ID = '44444444-4444-4444-8444-444444444444'
const USER_ID = '33333333-3333-4333-8333-333333333333'
const ITEM_ID = '22222222-2222-4222-8222-222222222222'

const SCRIPT_A = 'import Part\nresult = Part.makeBox(10, 10, undefined_h)\n'
const SCRIPT_B = 'import Part\nresult = Part.makeBox(10, 10, 5)\n'

function okReport(): FreecadScriptResult {
  return {
    ok: true,
    freecadVersion: '1.1.3',
    executionTimeMs: 40,
    stdout: '',
    stderr: '',
    issues: [],
    geometry: {
      solidCount: 1,
      faceCount: 6,
      edgeCount: 12,
      volumeMm3: 500,
      surfaceAreaMm2: 400,
      isValid: true,
      boundingBox: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 5 },
    },
  }
}

function failReport(message: string): FreecadScriptResult {
  return {
    ok: false,
    freecadVersion: '1.1.3',
    executionTimeMs: 20,
    stdout: '',
    stderr: '',
    errorMessage: message,
    traceback: `Traceback (most recent call last):\n  File "part_script.py", line 2\n${message}\n`,
    issues: [message],
  }
}

/** Per-script outcome for the fake worker: a report, or an error to throw. */
let outcomes: Record<string, FreecadScriptResult | Error> = {}
/** Every execution the fake worker saw, in order. */
const executions: Array<{ script: string; persist: boolean }> = []
/** Hook a test may install to act mid-execution (e.g. abort the caller). */
let onExecute: ((options: ExecuteFreecadScriptOptions) => void) | null = null

const execute = (
  options: ExecuteFreecadScriptOptions,
): Promise<FreecadScriptResult> => {
  executions.push({ script: options.script, persist: options.persist })
  onExecute?.(options)
  const outcome = outcomes[options.script]
  if (!outcome) {
    return Promise.reject(
      new Error(`no scripted outcome for: ${options.script}`),
    )
  }
  if (outcome instanceof Error) return Promise.reject(outcome)
  return Promise.resolve(
    options.persist
      ? { ...outcome, vaultFileId: VAULT_FILE_ID, fileName: 'Bracket.step' }
      : outcome,
  )
}

function generate(overrides: Record<string, unknown> = {}) {
  return generatePartWithFreecad({
    promptContext: {
      partName: 'Bracket',
      partDescription: 'An L bracket',
      interfaces: [],
    },
    partName: 'Bracket',
    userId: USER_ID,
    itemId: ITEM_ID,
    execute,
    ...overrides,
  })
}

beforeEach(() => {
  turns = []
  chatCalls.length = 0
  toolOutputs.length = 0
  executions.length = 0
  outcomes = {}
  onExecute = null
  settings.enabled = true
  settings.maxIterations = 3
})

describe('generatePartWithFreecad', () => {
  it('persists exactly the accepted script, exactly once, after iterating', async () => {
    outcomes = {
      [SCRIPT_A]: failReport('NameError: undefined_h'),
      [SCRIPT_B]: okReport(),
    }
    turns = [
      { tool: { script: SCRIPT_A } },
      { tool: { script: SCRIPT_B, notes: 'fixed the height' } },
      { text: 'Built a 10×10×5 mm block.' },
    ]
    const usage = new UsageAccumulator()

    const result = await generate({ usage })

    // Two dry runs, then the persisting run of the script that passed.
    expect(executions).toEqual([
      { script: SCRIPT_A, persist: false },
      { script: SCRIPT_B, persist: false },
      { script: SCRIPT_B, persist: true },
    ])
    expect(result).toMatchObject({
      success: true,
      vaultFileId: VAULT_FILE_ID,
      fileName: 'Bracket.step',
      script: SCRIPT_B,
      iterations: 2,
      summary: 'Built a 10×10×5 mm block.',
    })
    // The model saw the failure and then the geometry it could check.
    expect(toolOutputs[0]).toMatchObject({
      ok: false,
      accepted: true,
      attempt: 1,
    })
    expect(toolOutputs[1]).toMatchObject({
      ok: true,
      accepted: true,
      attempt: 2,
      geometry: { size: { x: 10, y: 10, z: 5 } },
    })
    // Tokens land in the caller's accumulator; the caller writes the row.
    expect(usage.totals).toEqual({ inputTokens: 100, outputTokens: 50 })
  })

  it('keeps the accepted geometry when a later attempt fails', async () => {
    outcomes = {
      [SCRIPT_B]: okReport(),
      [SCRIPT_A]: failReport('ValueError: fillet too large'),
    }
    turns = [
      { tool: { script: SCRIPT_B } },
      { tool: { script: SCRIPT_A, notes: 'tried a fillet' } },
      { text: 'The fillet failed; the plain block stands.' },
    ]

    const result = await generate()

    expect(result.success).toBe(true)
    expect(executions.filter((e) => e.persist)).toEqual([
      { script: SCRIPT_B, persist: true },
    ])
    if (result.success) expect(result.iterations).toBe(2)
  })

  it('enforces the attempt budget and tells the model so', async () => {
    settings.maxIterations = 2
    const scriptC = 'import Part\nresult = Part.makeBox(1, 1, 1)\n'
    outcomes = {
      [SCRIPT_A]: failReport('NameError: undefined_h'),
      [SCRIPT_B]: failReport('Part.OCCError: BRep_API: command not done'),
      [scriptC]: okReport(),
    }
    turns = [
      { tool: { script: SCRIPT_A } },
      { tool: { script: SCRIPT_B } },
      { tool: { script: scriptC } },
      { text: 'I ran out of attempts.' },
    ]

    const result = await generate()

    // The third call was refused without touching the worker...
    expect(executions.map((e) => e.script)).toEqual([SCRIPT_A, SCRIPT_B])
    expect(toolOutputs[2]).toMatchObject({
      accepted: false,
      attemptsRemaining: 0,
    })
    // ...and nothing was persisted.
    expect(executions.some((e) => e.persist)).toBe(false)
    expect(result).toMatchObject({ success: false, iterations: 2 })
    if (!result.success) {
      expect(result.errorMessage).toContain('after 2 attempts')
      expect(result.errorMessage).toContain('BRep_API')
      expect(result.lastScript).toBe(SCRIPT_B)
    }
  })

  it('ends the conversation on a worker outage instead of letting the model retry', async () => {
    outcomes = {
      [SCRIPT_A]: new Error('FreeCAD worker: no result within 210s'),
      [SCRIPT_B]: okReport(),
    }
    turns = [
      { tool: { script: SCRIPT_A } },
      { tool: { script: SCRIPT_B } },
      { text: 'Trying again.' },
    ]

    const result = await generate()

    // The stream was torn down after the first failure; B never ran.
    expect(executions.map((e) => e.script)).toEqual([SCRIPT_A])
    expect(chatCalls[0]?.abortController.signal.aborted).toBe(true)
    expect(toolOutputs[0]).toMatchObject({ accepted: false })
    expect(result).toMatchObject({ success: false })
    if (!result.success) {
      expect(result.errorMessage).toContain('FreeCAD worker')
    }
  })

  it('never reaches the model when generation is switched off', async () => {
    settings.enabled = false
    turns = [{ tool: { script: SCRIPT_B } }]
    outcomes = { [SCRIPT_B]: okReport() }

    const result = await generate()

    expect(chatCalls).toHaveLength(0)
    expect(executions).toHaveLength(0)
    expect(result).toEqual({
      success: false,
      errorMessage: 'AI CAD generation is disabled.',
      iterations: 0,
    })
  })

  it('runs a script the model returned inline instead of calling the tool', async () => {
    outcomes = { [SCRIPT_B.trim()]: okReport() }
    turns = [
      {
        text: `Here is the part:\n\n\`\`\`python\n${SCRIPT_B}\`\`\`\n\nDone.`,
      },
    ]

    const result = await generate()

    expect(executions).toEqual([
      { script: SCRIPT_B.trim(), persist: false },
      { script: SCRIPT_B.trim(), persist: true },
    ])
    expect(result).toMatchObject({ success: true, iterations: 1 })
  })

  it('reports a cancelled run and persists nothing', async () => {
    const controller = new AbortController()
    outcomes = { [SCRIPT_B]: okReport() }
    turns = [{ tool: { script: SCRIPT_B } }, { text: 'done' }]
    // The caller leaves while the worker is running the first attempt.
    onExecute = () => controller.abort()

    const result = await generate({ signal: controller.signal })

    expect(executions).toEqual([{ script: SCRIPT_B, persist: false }])
    expect(result).toMatchObject({ success: false, errorMessage: 'Cancelled' })
  })
})
