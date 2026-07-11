// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * Mid-stream steering mailbox tests — data-integrity gate.
 *
 * Guidance sent while a stream is in flight must never be lost or delivered
 * twice. Invariants: concurrent enqueues all survive; a drain returns every
 * pending message exactly once (a second drain is empty); draining an empty
 * mailbox is a no-op.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { DesignSessionService } from './session-service'
import type { UserMessage } from './types'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { programs } from '@/lib/db/schema'

function msg(text: string): UserMessage {
  return {
    id: crypto.randomUUID(),
    text,
    createdAt: new Date().toISOString(),
    stage: 'bom_drafting',
  }
}

describe('DesignSessionService guidance mailbox', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let sessionId: string

  beforeAll(() => {
    testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    user = await insertTestUser(testDb.db)
    const [program] = await testDb.db
      .insert(programs)
      .values({
        name: 'Mailbox Test Program',
        code: `PROG-MBX-${Date.now()}`,
        createdBy: user.id,
      })
      .returning()
    const session = await DesignSessionService.create(user.id, {
      description: 'steering test',
      programId: program!.id,
    })
    sessionId = session.id
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('sequential enqueues all survive and drain in order', async () => {
    const a = msg('use aluminum')
    const b = msg('keep it under 500g')
    const c = msg('prefer M4 fasteners')
    await DesignSessionService.enqueueGuidance(sessionId, a)
    await DesignSessionService.enqueueGuidance(sessionId, b)
    await DesignSessionService.enqueueGuidance(sessionId, c)

    const drained = await DesignSessionService.drainGuidance(sessionId)
    expect(drained.map((m) => m.id)).toEqual([a.id, b.id, c.id])
  })

  it('drain is exactly-once — a second drain returns nothing', async () => {
    await DesignSessionService.enqueueGuidance(sessionId, msg('first'))

    const first = await DesignSessionService.drainGuidance(sessionId)
    expect(first).toHaveLength(1)

    const second = await DesignSessionService.drainGuidance(sessionId)
    expect(second).toHaveLength(0)
  })

  it('draining an empty mailbox is a no-op', async () => {
    const drained = await DesignSessionService.drainGuidance(sessionId)
    expect(drained).toEqual([])
  })

  it('messages enqueued after a drain are delivered on the next drain', async () => {
    await DesignSessionService.enqueueGuidance(sessionId, msg('round one'))
    await DesignSessionService.drainGuidance(sessionId)

    const late = msg('round two')
    await DesignSessionService.enqueueGuidance(sessionId, late)
    const drained = await DesignSessionService.drainGuidance(sessionId)
    expect(drained.map((m) => m.id)).toEqual([late.id])
  })
})
