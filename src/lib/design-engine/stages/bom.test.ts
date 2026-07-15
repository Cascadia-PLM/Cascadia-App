import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TanStackAi from '@tanstack/ai'
import type { DesignSession } from '../session-service'
import type {
  BomDraft,
  BomNodeDraft,
  ClarificationEntry,
  StageEvent,
} from '../types'

const chatCalls: Array<{
  messages: Array<{ role: string; content: string }>
  tools: Array<unknown>
}> = []
/** Chunks the fake model emits. Empty means it proposed nothing. */
let chunks: Array<unknown> = []

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  chat: (opts: {
    messages: Array<{ role: string; content: string }>
    tools: Array<unknown>
  }) => {
    chatCalls.push({ messages: opts.messages, tools: opts.tools })
    return (async function* () {
      // Chunks arrive off the microtask queue, as they would from a real stream.
      await Promise.resolve()
      for (const chunk of chunks) yield chunk
    })()
  },
}))

vi.mock('@/lib/ai/adapters', () => ({
  loadProviderConfig: () => Promise.resolve({ provider: 'anthropic' }),
  getAdapter: () => ({}),
}))

vi.mock('../session-service', () => ({
  DesignSessionService: {
    updateStage: vi.fn(() => Promise.resolve()),
    updateArtifacts: vi.fn(() => Promise.resolve()),
    updateStatus: vi.fn(() => Promise.resolve()),
    // Steering mailbox: empty unless a test enqueues guidance
    drainGuidance: vi.fn(() => Promise.resolve([])),
    enqueueGuidance: vi.fn(() => Promise.resolve()),
  },
}))

const { runBomStage } = await import('./bom')

function node(tempId: string, overrides: Partial<BomNodeDraft> = {}) {
  return {
    tempId,
    name: tempId,
    isNew: true,
    quantity: 1,
    children: [],
    requirementTempIds: [],
    rationale: '',
    confidence: 1,
    partType: 'Manufacture' as const,
    ...overrides,
  }
}

function bomDraft(): BomDraft {
  return {
    rootAssembly: node('root', { name: 'Root', partType: 'Phantom' }),
    proposedParts: [],
    requirementsCoverage: {},
    uncoveredRequirements: [],
    validationIssues: [],
  }
}

function clarification(i: number): ClarificationEntry {
  return {
    questionId: `q-${i}`,
    question: `Clarification ${i}?`,
    answer: `Answer ${i}`,
    answeredAt: new Date(0).toISOString(),
    stage: 'bom_drafting',
  }
}

function session(
  bom: BomDraft | null,
  clarifications: Array<ClarificationEntry> = [],
): DesignSession {
  return {
    id: 'session-1',
    userId: 'user-1',
    aiChatSessionId: null,
    programId: 'program-1',
    designId: null,
    title: null,
    // Confirming the requirements stage leaves the session parked here before
    // BOM generation has ever run.
    stage: 'bom_drafting',
    status: 'active',
    description: 'A hand cart',
    artifacts: {
      description: 'A hand cart',
      requirements: [],
      bom,
      clarifications,
      userMessages: [],
    },
    llmHistory: [
      {
        role: 'tool',
        content: JSON.stringify({
          toolName: 'propose_requirement',
          args: { name: 'Payload' },
        }),
      },
    ],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    completedAt: null,
    materializedDesignId: null,
    errorMessage: null,
    pendingGuidance: [],
    forkedFromSessionId: null,
  }
}

async function collect(
  bom: BomDraft | null,
  clarifications: Array<ClarificationEntry> = [],
): Promise<Array<StageEvent>> {
  const events: Array<StageEvent> = []
  for await (const event of runBomStage(session(bom, clarifications)))
    events.push(event)
  return events
}

function userMessage(): string {
  const call = chatCalls[chatCalls.length - 1]
  return call?.messages.find((m) => m.role === 'user')?.content ?? ''
}

function systemMessage(): string {
  const call = chatCalls[chatCalls.length - 1]
  return call?.messages.find((m) => m.role === 'system')?.content ?? ''
}

function lastToolCount(): number {
  return chatCalls[chatCalls.length - 1]?.tools.length ?? 0
}

describe('runBomStage', () => {
  beforeEach(() => {
    chatCalls.length = 0
    chunks = []
  })

  it('treats a first run at bom_drafting as a fresh start, not a resume', async () => {
    await collect(null)

    expect(userMessage()).toContain('Build a Bill of Materials')
    expect(userMessage()).not.toContain('Continue building')
    // Prior-stage tool calls must not be replayed as "already done" context.
    expect(systemMessage()).not.toContain('Prior Tool Calls')
  })

  it('treats a run with a partial BOM as a resume', async () => {
    await collect(bomDraft())

    expect(userMessage()).toContain('Continue building')
    expect(systemMessage()).toContain('Work Done So Far')
  })

  // The never-propose loop: a session that only ever asked clarifications (and
  // built no tree) must resume, not restart from scratch every round.
  it('treats a run with prior clarifications but no BOM as a resume', async () => {
    await collect(null, [clarification(0)])

    expect(userMessage()).toContain('Continue building')
    expect(userMessage()).not.toContain('Build a Bill of Materials for this')
  })

  it('withholds clarification and forces a build once the budget is spent', async () => {
    await collect(null, [])
    const fullToolCount = lastToolCount()

    chatCalls.length = 0
    const spentBudget = Array.from({ length: 6 }, (_, i) => clarification(i))
    await collect(null, spentBudget)

    expect(lastToolCount()).toBe(fullToolCount - 1)
    expect(systemMessage()).toContain('Time to Build')
  })

  // A dropped socket ("terminated") is transient: retry rather than destroying
  // the run. A non-transient rejection (see the 400 test) must NOT retry.
  it('retries a transient provider error before giving up', async () => {
    chunks = [{ type: 'error', error: { message: 'terminated' } }]

    const events = await collect(null)

    // Initial attempt + MAX_TRANSIENT_RETRIES (2) = 3 chat calls.
    expect(chatCalls).toHaveLength(3)
    expect(
      events.some((e) => e.type === 'llm_text' && e.text.includes('retrying')),
    ).toBe(true)
    const errors = events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
    expect(errors.some((m) => m.includes('terminated'))).toBe(true)
  })

  it('does not advance to bom_review when no parts were proposed', async () => {
    const events = await collect(null)

    expect(events.map((e) => e.type)).toContain('error')
    const stages = events.flatMap((e) =>
      e.type === 'stage_change' ? [e.stage] : [],
    )
    expect(stages).toEqual(['bom_drafting'])
    expect(events.some((e) => e.type === 'stage_complete')).toBe(false)
  })

  it('advances to bom_review once a BOM exists', async () => {
    const events = await collect(bomDraft())

    const stages = events.flatMap((e) =>
      e.type === 'stage_change' ? [e.stage] : [],
    )
    expect(stages).toContain('bom_review')
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  // The adapter reports API failures as a terminal `error` chunk instead of
  // throwing, so an unhandled one reads as "the model said nothing".
  it('surfaces a provider error chunk instead of reporting an empty BOM', async () => {
    chunks = [
      {
        type: 'error',
        error: { message: 'input_schema: JSON schema is invalid', code: '400' },
      },
    ]

    const events = await collect(null)
    const errors = events.flatMap((e) =>
      e.type === 'error' ? [e.message] : [],
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('input_schema: JSON schema is invalid')
    expect(errors[0]).toContain('400')
    // The misleading "proposed no parts" message must not mask the real cause.
    expect(errors[0]).not.toContain('without proposing any parts')
  })

  // A token-cap cutoff still leaves usable partial work, so it must not abort.
  it('warns but keeps the run alive on a max_tokens cutoff', async () => {
    chunks = [
      {
        type: 'error',
        error: { message: 'response was cut off', code: 'max_tokens' },
      },
    ]

    const events = await collect(bomDraft())
    const stages = events.flatMap((e) =>
      e.type === 'stage_change' ? [e.stage] : [],
    )

    expect(stages).toContain('bom_review')
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(
      events.some((e) => e.type === 'llm_text' && e.text.includes('cut off')),
    ).toBe(true)
  })
})
