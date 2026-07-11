import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TanStackAi from '@tanstack/ai'
import type { DesignSession } from '../session-service'
import type { RequirementDraft, StageEvent } from '../types'

const chatCalls: Array<{ messages: Array<{ role: string; content: string }> }> =
  []

vi.mock('@tanstack/ai', async (importOriginal) => ({
  ...(await importOriginal<typeof TanStackAi>()),
  // The fake model emits no chunks: it proposes nothing and calls no tools.
  chat: (opts: { messages: Array<{ role: string; content: string }> }) => {
    chatCalls.push({ messages: opts.messages })
    return (async function* () {})()
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

function session(requirements: Array<RequirementDraft>): DesignSession {
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
      clarifications: [],
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
): Promise<Array<StageEvent>> {
  const events: Array<StageEvent> = []
  for await (const event of runRequirementsStage(session(requirements))) {
    events.push(event)
  }
  return events
}

function lastMessage(role: string): string {
  const call = chatCalls[chatCalls.length - 1]
  return call?.messages.find((m) => m.role === role)?.content ?? ''
}

describe('runRequirementsStage', () => {
  beforeEach(() => {
    chatCalls.length = 0
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
