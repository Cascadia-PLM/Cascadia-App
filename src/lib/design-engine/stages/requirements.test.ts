import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TanStackAi from '@tanstack/ai'
import type { DesignSession } from '../session-service'
import type {
  ClarificationEntry,
  RequirementDraft,
  StageEvent,
} from '../types'

const chatCalls: Array<{
  messages: Array<{ role: string; content: string }>
  tools: Array<unknown>
}> = []
/** Chunks the fake model emits. Empty means it proposes nothing. */
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

const { runRequirementsStage } = await import('./requirements')

function requirement(): RequirementDraft {
  return {
    tempId: 'req-1',
    name: 'Payload Capacity',
    description: 'Carries 250 kg',
    requirementType: 'Performance',
    priority: 'critical',
    verificationMethod: 'Test',
    rationale: '',
    confidence: 1,
    source: 'ai',
  }
}

function clarification(i: number): ClarificationEntry {
  return {
    questionId: `q-${i}`,
    question: `Clarification ${i}?`,
    answer: `Answer ${i}`,
    answeredAt: new Date(0).toISOString(),
    stage: 'requirements_drafting',
  }
}

function session(
  requirements: Array<RequirementDraft>,
  clarifications: Array<ClarificationEntry> = [],
): DesignSession {
  return {
    id: 'session-1',
    userId: 'user-1',
    aiChatSessionId: null,
    programId: 'program-1',
    designId: null,
    title: null,
    // Confirming the toolset stage leaves the session parked here before
    // requirements analysis has ever run.
    stage: 'requirements_drafting',
    status: 'active',
    description: 'A hand cart',
    artifacts: {
      description: 'A hand cart',
      requirements,
      bom: null,
      clarifications,
      userMessages: [],
    },
    llmHistory: [
      {
        role: 'tool',
        content: JSON.stringify({
          toolName: 'search_tool_library',
          args: { query: 'welder' },
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
  requirements: Array<RequirementDraft>,
  clarifications: Array<ClarificationEntry> = [],
): Promise<Array<StageEvent>> {
  const events: Array<StageEvent> = []
  for await (const event of runRequirementsStage(
    session(requirements, clarifications),
  )) {
    events.push(event)
  }
  return events
}

function lastMessage(role: string): string {
  const call = chatCalls[chatCalls.length - 1]
  return call?.messages.find((m) => m.role === role)?.content ?? ''
}

function lastToolCount(): number {
  return chatCalls[chatCalls.length - 1]?.tools.length ?? 0
}

describe('runRequirementsStage', () => {
  beforeEach(() => {
    chatCalls.length = 0
    chunks = []
  })

  it('treats a first run at requirements_drafting as a fresh start, not a resume', async () => {
    await collect([])

    expect(lastMessage('user')).toContain('Please analyze')
    expect(lastMessage('user')).not.toContain('Continue analyzing')
    // Toolset-stage tool calls must not be replayed as "already done" context.
    expect(lastMessage('system')).not.toContain('Prior Tool Calls')
  })

  it('treats a run with prior requirements as a resume', async () => {
    await collect([requirement()])

    expect(lastMessage('user')).toContain('Continue analyzing')
    expect(lastMessage('system')).toContain('Work Done So Far')
  })

  // The never-propose loop: a session that only ever asked clarifications (and
  // proposed nothing) must resume, not restart from scratch every round.
  it('treats a run with prior clarifications but no requirements as a resume', async () => {
    await collect([], [clarification(0)])

    expect(lastMessage('user')).toContain('Continue analyzing')
    expect(lastMessage('user')).not.toContain('Please analyze')
  })

  it('withholds clarification and forces proposals once the budget is spent', async () => {
    await collect([], [])
    const fullToolCount = lastToolCount()

    chatCalls.length = 0
    const spentBudget = Array.from({ length: 6 }, (_, i) => clarification(i))
    await collect([], spentBudget)

    // The clarification tool is withheld so the model cannot keep stalling.
    expect(lastToolCount()).toBe(fullToolCount - 1)
    // And the prompt requires concrete proposals this turn.
    expect(lastMessage('system')).toContain('Time to Propose')
  })

  // A dropped socket ("terminated") is transient: retry rather than destroying
  // the run. A non-transient rejection (bad schema/400) must NOT retry.
  it('retries a transient provider error before giving up', async () => {
    chunks = [{ type: 'error', error: { message: 'terminated' } }]

    const events = await collect([])

    // Initial attempt + MAX_TRANSIENT_RETRIES (2) = 3 chat calls.
    expect(chatCalls).toHaveLength(3)
    expect(
      events.some((e) => e.type === 'llm_text' && e.text.includes('retrying')),
    ).toBe(true)
    const errors = events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
    expect(errors.some((m) => m.includes('terminated'))).toBe(true)
  })

  // A genuine rejection must surface immediately, not be retried as transient.
  it('surfaces a non-transient provider error without retrying', async () => {
    chunks = [
      {
        type: 'error',
        error: { message: 'input_schema: JSON schema is invalid', code: '400' },
      },
    ]

    const events = await collect([])

    expect(chatCalls).toHaveLength(1)
    const errors = events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
    expect(errors.some((m) => m.includes('JSON schema is invalid'))).toBe(true)
  })

  it('does not advance to requirements_review when nothing was proposed', async () => {
    const events = await collect([])

    expect(events.map((e) => e.type)).toContain('error')
    const stages = events.flatMap((e) =>
      e.type === 'stage_change' ? [e.stage] : [],
    )
    expect(stages).toEqual(['requirements_drafting'])
    expect(events.some((e) => e.type === 'stage_complete')).toBe(false)
  })

  it('advances to requirements_review once requirements exist', async () => {
    const events = await collect([requirement()])

    const stages = events.flatMap((e) =>
      e.type === 'stage_change' ? [e.stage] : [],
    )
    expect(stages).toContain('requirements_review')
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })
})
