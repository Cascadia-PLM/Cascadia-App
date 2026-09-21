// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Cross-process cancel, seen from the worker's side (JOBS-6).
 *
 * Data-integrity gate. `JobService.test.ts` in the api pins what the *rows* do
 * when a cancel races a late completion; these two cases pin what the *worker*
 * does with the same rows — that a timeout aborts the controller a cooperative
 * handler is watching, and that a handler which honours its signal notices a
 * cancel from another process at its next progress checkpoint. They lived in
 * the api suite until the worker became its own package; the api cannot reach
 * `createJobContext` and `executeWithTimeout` from there, and should not.
 *
 * Run: npx vitest run cascadia-workers-job/src/worker/cancel.test.ts
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
import { z } from 'zod'
import { TestDatabase } from '@test/helpers/db'
import { insertTestUser } from '@test/fixtures/users'
import { JobService } from '@cascadia/api/lib/jobs/JobService'
import { JobTypeRegistry } from '@cascadia/api/lib/jobs/registry'
import { jobs } from '@cascadia/api/lib/db/schema/jobs'
import { takeFirst } from '@cascadia/api/lib/db/take-first'
import type { JobStatus } from '@cascadia/api/lib/db/schema/jobs'
import type { TestUser } from '@test/fixtures/users'
import { createJobContext, executeWithTimeout } from '@/worker'

const TEST_TYPE = 'test.jobs.worker-cancel'
const MAX_ATTEMPTS = 3

describe('JobWorker — cancel and timeout from the handler side', () => {
  const testDb = new TestDatabase()
  let user: TestUser

  beforeAll(async () => {
    await testDb.setup()
    JobTypeRegistry.register({
      type: TEST_TYPE,
      label: 'Worker cancel fixture',
      routingKey: 'jobs.test.worker-cancel',
      payloadSchema: z.object({}),
      resultSchema: z.object({}),
      timeout: 1000,
      maxAttempts: MAX_ATTEMPTS,
      retryDelays: [30000, 60000, 120000],
      priority: 'normal',
    })
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  async function insertJob(status: JobStatus, attempts = 0) {
    return takeFirst(
      await testDb.db
        .insert(jobs)
        .values({
          type: TEST_TYPE,
          status,
          payload: {},
          createdBy: user.id,
          maxAttempts: MAX_ATTEMPTS,
          attempts,
        })
        .returning(),
    )
  }

  async function rowFor(jobId: string) {
    const row = await JobService.get(jobId)
    if (!row) throw new Error(`job ${jobId} vanished`)
    return row
  }

  it('a handler that ignores its signal past the timeout ends failed, and its late completion is a no-op', async () => {
    const job = await insertJob('queued', MAX_ATTEMPTS - 1)
    await JobService.claimJob(job.id) // attempts -> MAX_ATTEMPTS

    const controller = new AbortController()
    const ignoresItsSignal = new Promise<never>(() => {})

    await expect(
      executeWithTimeout(ignoresItsSignal, 50, controller),
    ).rejects.toThrow(/timed out after 50ms/)
    // The timeout aborted the controller — this is what actually stops a
    // cooperative handler, not just the rejection.
    expect(controller.signal.aborted).toBe(true)

    await JobService.markFailed(job.id, 'Job timed out after 50ms')
    let row = await rowFor(job.id)
    expect(row.status).toBe('failed')

    await JobService.markCompleted(job.id, { zombie: true })
    row = await rowFor(job.id)
    expect(row.status).toBe('failed')
    expect(row.result).toBeNull()
  })

  it('a handler that honors its signal aborts within one progress checkpoint of cancel', async () => {
    const job = await insertJob('queued')
    await JobService.claimJob(job.id)

    const controller = new AbortController()
    const context = createJobContext(job.id, 1, controller)

    await context.updateProgress(10, 'step 1')
    expect(controller.signal.aborted).toBe(false)

    await JobService.cancel(job.id) // another process cancels

    await context.updateProgress(20, 'step 2') // next checkpoint notices
    expect(controller.signal.aborted).toBe(true)
  })
})
