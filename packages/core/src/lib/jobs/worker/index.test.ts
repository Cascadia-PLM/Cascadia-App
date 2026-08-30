// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Node jobs worker: message-handling invariants when the database is down
 *
 * Data-integrity and control-flow gates. Every database call `handleMessage`
 * makes used to be uncontained, and the consume callback discarded the
 * promise, so a transient Postgres outage while messages were flowing did not
 * degrade the worker — it killed the process with an unhandled rejection and
 * crash-looped it for the length of the outage.
 *
 * These tests drive the failures by name rather than by mock shape: the claim
 * really rejects, the failure-marking writes really reject, the payload really
 * fails its schema. What is asserted is the delivery's fate, because that is
 * the thing that decides whether a job is lost — an ack consumes the job's
 * only wake-up, a requeue hands it back, a nack without requeue sends it to
 * the dead-letter exchange.
 *
 * No database is involved on purpose. `JobService` is the boundary being
 * failed, and a real Postgres cannot be asked to fail on cue; the channel is
 * likewise a pair of spies, with `RabbitMQClient.getChannel` pointed at it so
 * the channel-identity guard in `ack`/`nack` treats it as current.
 *
 * Run: npx vitest run packages/core/src/lib/jobs/worker/index.test.ts
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { z } from 'zod'
import type { Channel, ConsumeMessage } from 'amqplib'
import type { Job } from '@/lib/jobs/JobService'
import { JobService } from '@/lib/jobs/JobService'
import { JobTypeRegistry } from '@/lib/jobs/registry'
import { RabbitMQClient } from '@/lib/jobs/rabbitmq/client'
import { JobWorker } from '@/lib/jobs/worker'
import { installProcessBackstops } from '@/jobs-worker-main'
import { workerLogger } from '@/lib/logging/logger'

const TEST_TYPE = 'test.jobs.worker-containment'
const JOB_ID = '11111111-1111-4111-8111-111111111111'

/** What the registered handler does on the next delivery. */
let handlerBehaviour: () => Promise<Record<string, unknown>> = () =>
  Promise.resolve({ ok: true })
/** Payloads the handler was actually given, so "never executed" is checkable. */
let executed: Array<unknown> = []

/**
 * `handleMessage` is private, and deliberately stays private: the ack/nack
 * channel discipline around it was built carefully and is not worth reshaping
 * for a test. This is the narrowest way to reach it — a structural cast of the
 * one method, with no change to the class.
 */
interface MessageHandling {
  handleMessage: (
    msg: ConsumeMessage | null,
    deliveryChannel: Channel,
  ) => Promise<void>
}

/** A delivery carrying `body` — only `content` is ever read. */
function delivery(body: unknown): ConsumeMessage {
  const content =
    typeof body === 'string'
      ? Buffer.from(body)
      : Buffer.from(JSON.stringify(body))
  return { content } as unknown as ConsumeMessage
}

/** A well-formed job message for the registered fixture type. */
function jobMessage(): Record<string, unknown> {
  return { jobId: JOB_ID, type: TEST_TYPE, priority: 3, attemptNumber: 1 }
}

/** The row a successful claim returns. */
function claimedJob(payload: Record<string, unknown>): Job {
  return {
    id: JOB_ID,
    type: TEST_TYPE,
    status: 'running',
    priority: 'normal',
    payload,
    result: null,
    error: null,
    progress: 0,
    progressMessage: null,
    itemId: null,
    createdBy: null,
    createdAt: new Date(),
    queuedAt: new Date(),
    startedAt: new Date(),
    completedAt: null,
    attempts: 1,
    maxAttempts: 3,
    retryDelays: [30000, 60000, 120000],
    nextRetryAt: null,
  }
}

function fakeChannel() {
  const ack = vi.fn()
  const nack = vi.fn()
  return { channel: { ack, nack } as unknown as Channel, ack, nack }
}

describe('jobs worker message handling', () => {
  const worker = new JobWorker({
    queueName: 'test-worker-containment',
    routingPatterns: ['jobs.test.worker-containment'],
    concurrency: 1,
    timeout: 5000,
  })
  let fake: ReturnType<typeof fakeChannel>

  beforeAll(() => {
    JobTypeRegistry.register({
      type: TEST_TYPE,
      label: 'Worker containment fixture',
      routingKey: 'jobs.test.worker-containment',
      payloadSchema: z.object({ widgetId: z.string().uuid() }),
      resultSchema: z.object({ ok: z.boolean() }),
      timeout: 5000,
      maxAttempts: 3,
      retryDelays: [30000, 60000, 120000],
      priority: 'normal',
    })
    JobTypeRegistry.registerHandler<unknown, Record<string, unknown>>({
      type: TEST_TYPE,
      execute: (payload) => {
        executed.push(payload)
        return handlerBehaviour()
      },
    })
  })

  beforeEach(() => {
    executed = []
    handlerBehaviour = () => Promise.resolve({ ok: true })
    fake = fakeChannel()
    // The identity guard in ack()/nack() drops settlements from a superseded
    // channel; pointing the client at the fake is what makes it current.
    vi.spyOn(RabbitMQClient, 'getChannel').mockReturnValue(fake.channel)
    // Keep an outage from redelivering on the production five-second cadence.
    process.env.WORKER_CLAIM_RETRY_DELAY_MS = '40'
  })

  afterEach(() => {
    delete process.env.WORKER_CLAIM_RETRY_DELAY_MS
  })

  const deliver = (body: unknown) =>
    (worker as unknown as MessageHandling).handleMessage(
      delivery(body),
      fake.channel,
    )

  it('requeues after a pause, and never acks, when the claim itself fails', async () => {
    const claim = vi
      .spyOn(JobService, 'claimJob')
      .mockRejectedValue(new Error('connection terminated unexpectedly'))
    const markFailed = vi
      .spyOn(JobService, 'markFailed')
      .mockResolvedValue(undefined)

    const startedAt = Date.now()
    // Resolving rather than rejecting is the containment: this promise is
    // discarded by the consume callback, so a rejection here is an unhandled
    // rejection and Node ends the process on one.
    await expect(deliver(jobMessage())).resolves.toBeUndefined()
    const elapsedMs = Date.now() - startedAt

    expect(claim).toHaveBeenCalledOnce()
    // Requeue, not ack: the claim never landed, so the row is still
    // pending/queued and this delivery is the only thing that will wake it.
    expect(fake.nack).toHaveBeenCalledWith(expect.anything(), false, true)
    expect(fake.ack).not.toHaveBeenCalled()
    // And nothing was written about a job whose row was never touched.
    expect(markFailed).not.toHaveBeenCalled()
    // The pause is what keeps an outage from spinning the queue at full speed.
    expect(elapsedMs).toBeGreaterThanOrEqual(30)
  })

  it('dead-letters a valid-JSON body that is not a job message, without touching the database', async () => {
    const claim = vi.spyOn(JobService, 'claimJob').mockResolvedValue(null)
    const addLog = vi.spyOn(JobService, 'addLog').mockResolvedValue(undefined)
    const markFailed = vi
      .spyOn(JobService, 'markFailed')
      .mockResolvedValue(undefined)

    // Parses as JSON, and used to be cast straight to a JobMessage: the
    // non-uuid jobId reached claimJob and came back as a Postgres
    // invalid-input error, indistinguishable from the database being down.
    await deliver({
      jobId: 'not-a-uuid',
      type: TEST_TYPE,
      priority: 3,
      attemptNumber: 1,
    })

    expect(fake.nack).toHaveBeenCalledWith(expect.anything(), false, false)
    expect(fake.ack).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
    expect(addLog).not.toHaveBeenCalled()
    expect(markFailed).not.toHaveBeenCalled()
  })

  it('dead-letters a body that is not JSON at all', async () => {
    const claim = vi.spyOn(JobService, 'claimJob').mockResolvedValue(null)

    await deliver('{not json')

    expect(fake.nack).toHaveBeenCalledWith(expect.anything(), false, false)
    expect(fake.ack).not.toHaveBeenCalled()
    expect(claim).not.toHaveBeenCalled()
  })

  it('still acks, and logs, when the failure path cannot reach the database', async () => {
    vi.spyOn(JobService, 'claimJob').mockResolvedValue(
      claimedJob({ widgetId: '22222222-2222-4222-8222-222222222222' }),
    )
    const outage = () =>
      Promise.reject(new Error('connection terminated unexpectedly'))
    const addLog = vi.spyOn(JobService, 'addLog').mockImplementation(outage)
    const markFailed = vi
      .spyOn(JobService, 'markFailed')
      .mockImplementation(outage)
    const logged = vi.spyOn(workerLogger, 'error').mockReturnValue(undefined)
    handlerBehaviour = () => Promise.reject(new Error('handler blew up'))

    await expect(deliver(jobMessage())).resolves.toBeUndefined()

    // Both writes were attempted: they are contained separately so that a lost
    // log does not skip the mark, which is the load-bearing half.
    expect(addLog).toHaveBeenCalledOnce()
    expect(markFailed).toHaveBeenCalledOnce()
    // Acked anyway. The row is left 'running' for the stale-running sweep to
    // reap — the accepted residual, and the reason JOBS2-2 lands first.
    expect(fake.ack).toHaveBeenCalledOnce()
    expect(fake.nack).not.toHaveBeenCalled()
    expect(logged).toHaveBeenCalled()
  })

  it('marks a job failed without executing it when its payload fails the type schema', async () => {
    vi.spyOn(JobService, 'claimJob').mockResolvedValue(
      claimedJob({ widgetId: 'not-a-uuid' }),
    )
    vi.spyOn(JobService, 'addLog').mockResolvedValue(undefined)
    const markFailed = vi
      .spyOn(JobService, 'markFailed')
      .mockResolvedValue(undefined)

    await deliver(jobMessage())

    expect(executed).toHaveLength(0)
    expect(markFailed).toHaveBeenCalledWith(JOB_ID, expect.any(String))
    expect(fake.ack).toHaveBeenCalledOnce()
    expect(fake.nack).not.toHaveBeenCalled()
  })

  it('executes a job whose payload matches, and acks on completion', async () => {
    const payload = { widgetId: '33333333-3333-4333-8333-333333333333' }
    vi.spyOn(JobService, 'claimJob').mockResolvedValue(claimedJob(payload))
    const markCompleted = vi
      .spyOn(JobService, 'markCompleted')
      .mockResolvedValue(undefined)

    await deliver(jobMessage())

    // The gate is a gate: the handler is handed the stored payload, not a
    // schema-narrowed copy of it.
    expect(executed).toEqual([payload])
    expect(markCompleted).toHaveBeenCalledOnce()
    expect(fake.ack).toHaveBeenCalledOnce()
    expect(fake.nack).not.toHaveBeenCalled()
  })
})

describe('jobs worker process backstops', () => {
  it('registers an unhandledRejection and an uncaughtException handler', () => {
    const before = {
      rejection: process.listeners('unhandledRejection'),
      exception: process.listeners('uncaughtException'),
    }

    installProcessBackstops()

    const addedRejection = process
      .listeners('unhandledRejection')
      .filter((listener) => !before.rejection.includes(listener))
    const addedException = process
      .listeners('uncaughtException')
      .filter((listener) => !before.exception.includes(listener))
    try {
      expect(addedRejection).toHaveLength(1)
      expect(addedException).toHaveLength(1)
    } finally {
      // Leaving them installed would let this file's backstops swallow a
      // genuine unhandled rejection from a later test in the same process.
      for (const listener of addedRejection) {
        process.off('unhandledRejection', listener)
      }
      for (const listener of addedException) {
        process.off('uncaughtException', listener)
      }
    }
  })
})
