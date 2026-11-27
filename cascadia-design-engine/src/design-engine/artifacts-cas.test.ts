// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Artifacts compare-and-set invariants
 *
 * Data-integrity gate. The artifacts document had read-modify-write updaters
 * outside the stream — engine edits, the PATCH route — that read the session
 * and blindly wrote the whole blob back, silently reverting whatever landed
 * in between. Writes now bump a monotonic version counter, and a caller that
 * passes the version it read gets a 409 instead of a lost update.
 *
 * The stage generators keep the un-versioned path deliberately: DE-1's
 * stream claim makes the running stream the session's only streaming writer.
 *
 * Run: npx vitest run cascadia-design-engine/src/design-engine/artifacts-cas.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { DesignArtifacts } from '@/design-engine/types'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { CollaborativeDesignEngine } from '@/design-engine/engine'
import { DesignSessionService } from '@/design-engine/session-service'
import { programs } from '@/db/schema'
import { ConflictError } from '@/errors'
import { takeFirst } from '@/db/take-first'

function artifactsWith(description: string): DesignArtifacts {
  return {
    description,
    requirements: [],
    bom: null,
    clarifications: [],
    userMessages: [],
  }
}

describe('design session artifacts compare-and-set', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let sessionId: string

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'CAS P',
          code: `CAS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const session = await DesignSessionService.create(user.id, {
      description: 'cas fixture',
      programId: program.id,
    })
    sessionId = session.id
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await testDb.rollback()
  })

  it('lets one of two writers holding the same version win; the other gets 409', async () => {
    const read = await DesignSessionService.getById(sessionId)
    const version = read!.artifactsVersion

    await DesignSessionService.updateArtifacts(
      sessionId,
      artifactsWith('writer A'),
      version,
    )

    await expect(
      DesignSessionService.updateArtifacts(
        sessionId,
        artifactsWith('writer B'),
        version,
      ),
    ).rejects.toThrow(ConflictError)

    // The winner's write is intact — no lost update.
    const after = await DesignSessionService.getById(sessionId)
    expect(after!.artifacts?.description).toBe('writer A')
    expect(after!.artifactsVersion).toBe(version + 1)
  })

  it('fails an engine edit whose read went stale, instead of reverting the other write', async () => {
    const engine = new CollaborativeDesignEngine()
    const stale = await DesignSessionService.getById(sessionId)

    // Another writer lands after the engine's read: the engine's next getById
    // is pinned to the stale snapshot, which is exactly the interleaving a
    // concurrent tab produces.
    await DesignSessionService.updateArtifacts(
      sessionId,
      artifactsWith('landed in between'),
      stale!.artifactsVersion,
    )
    vi.spyOn(DesignSessionService, 'getById').mockResolvedValueOnce(stale)

    await expect(
      engine.updateRequirements(sessionId, [
        { action: 'add', data: { name: 'stale requirement' } },
      ]),
    ).rejects.toThrow(ConflictError)

    // The other write survived — before the version counter, this edit
    // silently replaced it with the stale snapshot plus one requirement.
    const after = await DesignSessionService.getById(sessionId)
    expect(after!.artifacts?.description).toBe('landed in between')
    expect(after!.artifacts?.requirements).toHaveLength(0)
  })

  it('an un-versioned write (the stream path) still applies and bumps the version', async () => {
    const before = await DesignSessionService.getById(sessionId)

    await DesignSessionService.updateArtifacts(
      sessionId,
      artifactsWith('stage generator'),
    )

    const after = await DesignSessionService.getById(sessionId)
    expect(after!.artifacts?.description).toBe('stage generator')
    expect(after!.artifactsVersion).toBe(before!.artifactsVersion + 1)
  })
})
