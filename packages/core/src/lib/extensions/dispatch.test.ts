// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * What the dispatch layer guarantees, against a real database.
 *
 * Two of the three gates apply and they apply together: the dispatcher decides
 * whether a throw rolls a transaction back (data integrity), and the filter,
 * refusal and error-wrapping logic is non-obvious enough that reading it is not
 * enough (complex algorithm). The introspection route earns no test — it is a
 * delegating handler over a registry.
 *
 * Everything here is declared against a **test-local** event definition rather
 * than a shipped one, so a change to a real payload cannot quietly rewrite what
 * these assert, and so registering an extension here cannot affect any other
 * suite. No assertion reads a `seq`: sequencing is the event log's contract and
 * has its own tests.
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
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { ITEM_CREATE, ITEM_UPDATE } from './operations'
import { ExtensionRegistry, defineExtension } from './registry'
import {
  EXTENSION_HOP_CAP,
  ExtensionDispatchError,
  ExtensionRefusedError,
  dispatchGuard,
  guardOrThrow,
  hasGuardExtensions,
} from './dispatch'
import {
  EXTENSIONS_DISABLED_SETTING_KEY,
  enablementSource,
  extensionEnablementLoadCount,
  isExtensionEnabled,
  resetExtensionEnablementCache,
} from './enablement'
import type { TestUser } from '@/__tests__/fixtures/users'
import {
  EventTypeRegistry,
  defineDomainEvent,
  publishDomainEvent,
} from '@/lib/events'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { domainEvents, settings } from '@/lib/db/schema'
import { withSerializableRetry } from '@/lib/db/retry'
import { ErrorCode } from '@/lib/errors'
import { handleApiError } from '@/lib/errors/handleApiError'

const TEST_TYPE = 'test.extensions.dispatch'

describe('extension dispatch', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let SPEC: ReturnType<typeof defineSpec>

  function defineSpec() {
    return defineDomainEvent({
      type: TEST_TYPE,
      schemaVersion: 1,
      description: 'Test-only fact for the dispatch layer',
      payloadSchema: z.object({
        itemType: z.string(),
        marker: z.string(),
      }),
    })
  }

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    user = await insertTestUser(testDb.db)
    ExtensionRegistry.clear()
    EventTypeRegistry.clear()
    resetExtensionEnablementCache()
    SPEC = defineSpec()
  })

  afterEach(async () => {
    ExtensionRegistry.clear()
    EventTypeRegistry.clear()
    resetExtensionEnablementCache()
    await testDb.rollback()
  })

  /**
   * Rows this test could have written, and only those.
   *
   * `domain_events` carries committed rows from the concurrent-database race
   * suites, which commit by design — so "no rows at all" is never true here.
   * Scoping to the test-local type is what makes an emptiness assertion mean
   * what it says.
   */
  const eventsOfTestType = () =>
    testDb.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.type, TEST_TYPE))

  /** One publish, in a savepoint of the test's transaction. */
  const publish = (marker = 'm', itemType = 'Part') =>
    testDb.db.transaction((tx) =>
      publishDomainEvent(tx, SPEC, {
        actorId: user.id,
        payload: { itemType, marker },
      }),
    )

  /* ---------------------------------------------------------------- *
   * guard
   * ---------------------------------------------------------------- */

  describe('guard', () => {
    it('a refusal leaves no row of any kind', async () => {
      defineExtension({
        id: 'test.refuses',
        on: ITEM_CREATE,
        phase: 'guard',
        handler: () => ({ reason: 'not today' }),
      })

      await expect(
        guardOrThrow(
          ITEM_CREATE,
          {
            itemType: 'Part',
            designId: null,
            itemNumber: null,
            name: null,
            data: {},
          },
          { db: testDb.db, actorId: user.id },
        ),
      ).rejects.toBeInstanceOf(ExtensionRefusedError)

      expect(await eventsOfTestType()).toHaveLength(0)
    })

    it('a refusal is distinguishable at the call site from a fault', async () => {
      defineExtension({
        id: 'test.refuses',
        on: ITEM_CREATE,
        phase: 'guard',
        handler: () => ({ reason: 'policy' }),
      })
      defineExtension({
        id: 'test.faults',
        on: ITEM_UPDATE,
        phase: 'guard',
        handler: () => {
          throw new Error('the extension itself is broken')
        },
      })

      const intent = {
        itemType: 'Part',
        designId: null,
        itemNumber: null,
        name: null,
        data: {},
      }
      const refusal = await guardOrThrow(ITEM_CREATE, intent, {
        db: testDb.db,
        actorId: user.id,
      }).catch((error: unknown) => error)
      const fault = await guardOrThrow(
        ITEM_UPDATE,
        {
          itemId: user.id,
          masterId: user.id,
          itemType: 'Part',
          designId: null,
          itemNumber: null,
          stateId: 'Draft',
          stateIsInitial: true,
          stateIsReleased: false,
          stateIsFinal: false,
          stateFinalKind: null,
          revision: 'A',
          changedFields: [],
          changes: {},
        },
        { db: testDb.db, actorId: user.id },
      ).catch((error: unknown) => error)

      // A considered "no" and a broken extension are different answers, and
      // conflating them would let a bug read as policy.
      expect(refusal).toBeInstanceOf(ExtensionRefusedError)
      expect(fault).toBeInstanceOf(ExtensionDispatchError)
      expect((fault as ExtensionDispatchError).extensionId).toBe('test.faults')
    })

    it('names the refusing extension in the error', async () => {
      defineExtension({
        id: 'test.named-refusal',
        on: ITEM_CREATE,
        phase: 'guard',
        handler: () => ({ reason: 'parts are frozen' }),
      })
      const error = (await guardOrThrow(
        ITEM_CREATE,
        {
          itemType: 'Part',
          designId: null,
          itemNumber: null,
          name: null,
          data: {},
        },
        { db: testDb.db, actorId: user.id },
      ).catch((e: unknown) => e)) as ExtensionRefusedError

      expect(error.message).toContain('test.named-refusal')
      expect(error.message).toContain('parts are frozen')
      expect(error.refusals).toEqual([
        { extensionId: 'test.named-refusal', reason: 'parts are frozen' },
      ])
    })

    /**
     * Through the one function every route funnels its throws into. A refusal
     * that is not an `AppError` falls to that function's unknown branch and is
     * answered as a 500 with its reason discarded — which is how refusals first
     * shipped, with every guard test above still green.
     */
    it('reaches an API caller as a 422 carrying its reason', async () => {
      defineExtension({
        id: 'test.http-refusal',
        on: ITEM_CREATE,
        phase: 'guard',
        handler: () => ({ reason: 'part numbers are frozen for the audit' }),
      })
      const refusal = await guardOrThrow(
        ITEM_CREATE,
        {
          itemType: 'Part',
          designId: null,
          itemNumber: null,
          name: null,
          data: {},
        },
        { db: testDb.db, actorId: user.id },
      ).catch((error: unknown) => error)

      const response = handleApiError(refusal, undefined, 'req-refusal')
      const body = (await response.json()) as {
        error: { code: string; message: string }
      }
      expect(response.status).toBe(422)
      expect(body.error.code).toBe(ErrorCode.EXTENSION_REFUSED)
      expect(body.error.message).toContain(
        'part numbers are frozen for the audit',
      )
    })

    it('answers a broken guard as a 500 that does not repeat its internals', async () => {
      defineExtension({
        id: 'test.http-fault',
        on: ITEM_CREATE,
        phase: 'guard',
        handler: () => {
          throw new Error('select token from api_secrets where id = $1')
        },
      })
      const fault = await guardOrThrow(
        ITEM_CREATE,
        {
          itemType: 'Part',
          designId: null,
          itemNumber: null,
          name: null,
          data: {},
        },
        { db: testDb.db, actorId: user.id },
      ).catch((error: unknown) => error)

      const response = handleApiError(fault, undefined, 'req-fault')
      const body = (await response.json()) as { error: { message: string } }
      expect(response.status).toBe(500)
      expect(body.error.message).not.toContain('api_secrets')
    })

    it('reports the preview flag to the handler', async () => {
      const seen: Array<boolean> = []
      defineExtension({
        id: 'test.sees-preview',
        on: ITEM_CREATE,
        phase: 'guard',
        handler: (ctx) => {
          seen.push(ctx.preview)
        },
      })
      const intent = {
        itemType: 'Part',
        designId: null,
        itemNumber: null,
        name: null,
        data: {},
      }
      await dispatchGuard(ITEM_CREATE, intent, {
        db: testDb.db,
        actorId: user.id,
      })
      await dispatchGuard(ITEM_CREATE, intent, {
        db: testDb.db,
        actorId: user.id,
        preview: true,
      })
      expect(seen).toEqual([false, true])
    })

    it('costs nothing when nothing is registered', () => {
      expect(hasGuardExtensions(ITEM_CREATE)).toBe(false)
      defineExtension({
        id: 'test.registered',
        on: ITEM_CREATE,
        phase: 'guard',
        handler: () => undefined,
      })
      expect(hasGuardExtensions(ITEM_CREATE)).toBe(true)
      // ...and still nothing for an operation nobody registered against.
      expect(hasGuardExtensions(ITEM_UPDATE)).toBe(false)
    })
  })

  /* ---------------------------------------------------------------- *
   * when
   * ---------------------------------------------------------------- */

  describe('when', () => {
    it('dispatches nothing when the filter does not match', async () => {
      const ran: Array<string> = []
      defineExtension({
        id: 'test.filtered',
        on: SPEC,
        phase: 'in-transaction',
        when: { itemType: 'Document' },
        handler: ({ event }) => {
          ran.push(event.payload.marker)
          return Promise.resolve()
        },
      })

      await publish('m', 'Part')
      expect(ran).toEqual([])
    })

    it('matches everything when the filter is omitted', async () => {
      const ran: Array<string> = []
      defineExtension({
        id: 'test.unfiltered',
        on: SPEC,
        phase: 'in-transaction',
        handler: ({ event }) => {
          ran.push(event.payload.itemType)
          return Promise.resolve()
        },
      })

      await publish('m', 'Part')
      await publish('m', 'Document')
      expect(ran).toEqual(['Part', 'Document'])
    })

    it('matches one-of when the filter value is an array', async () => {
      const ran: Array<string> = []
      defineExtension({
        id: 'test.one-of',
        on: SPEC,
        phase: 'in-transaction',
        when: { itemType: ['Part', 'Tool'] },
        handler: ({ event }) => {
          ran.push(event.payload.itemType)
          return Promise.resolve()
        },
      })

      await publish('m', 'Part')
      await publish('m', 'Document')
      await publish('m', 'Tool')
      expect(ran).toEqual(['Part', 'Tool'])
    })
  })

  /* ---------------------------------------------------------------- *
   * in-transaction
   * ---------------------------------------------------------------- */

  describe('in-transaction', () => {
    it("writes land in the operation's transaction and roll back with it", async () => {
      defineExtension({
        id: 'test.writes',
        on: SPEC,
        phase: 'in-transaction',
        handler: async ({ tx }) => {
          await tx.insert(settings).values({
            key: 'test.extensions.wrote-this',
            value: 'yes',
            modifiedBy: user.id,
          })
        },
      })

      // Roll the whole thing back and confirm the handler's write went with it.
      await expect(
        testDb.db.transaction(async (tx) => {
          await publishDomainEvent(tx, SPEC, {
            actorId: user.id,
            payload: { itemType: 'Part', marker: 'm' },
          })
          throw new Error('caller aborts after the handler wrote')
        }),
      ).rejects.toThrow('caller aborts')

      const wrote = await testDb.db
        .select()
        .from(settings)
        .where(eq(settings.key, 'test.extensions.wrote-this'))
      expect(wrote).toHaveLength(0)
    })

    it('a throw rolls the operation back and the error names the extension', async () => {
      defineExtension({
        id: 'test.throws',
        on: SPEC,
        phase: 'in-transaction',
        handler: () => Promise.reject(new Error('handler said no')),
      })

      const error = (await testDb.db
        .transaction(async (tx) => {
          await publishDomainEvent(tx, SPEC, {
            actorId: user.id,
            payload: { itemType: 'Part', marker: 'm' },
          })
        })
        .catch((e: unknown) => e)) as ExtensionDispatchError

      expect(error).toBeInstanceOf(ExtensionDispatchError)
      expect(error.extensionId).toBe('test.throws')
      expect(error.phase).toBe('in-transaction')
      expect(error.message).toContain('test.throws')

      expect(await eventsOfTestType()).toHaveLength(0)
    })

    /**
     * The assertion this whole class exists for.
     *
     * All three release closures run under
     * `withSerializableRetry(fn, 3, ['40001', '40P01', '23505'])`. `23505` is
     * in that list, so an extension whose own unique-constraint violation
     * escaped un-wrapped would silently re-run the entire release closure —
     * four times for one logical release — and surface as a merge failure
     * naming the release rather than the extension.
     */
    it('an extension throw runs its retry closure once, not four times', async () => {
      defineExtension({
        id: 'test.raises-23505',
        on: SPEC,
        phase: 'in-transaction',
        handler: () => {
          // Exactly what a handler's own unique-constraint violation looks
          // like to the retry predicate.
          const violation = Object.assign(new Error('duplicate key value'), {
            code: '23505',
          })
          return Promise.reject(violation)
        },
      })

      let attempts = 0
      const error = await withSerializableRetry(
        async () => {
          attempts += 1
          return testDb.db.transaction(async (tx) => {
            await publishDomainEvent(tx, SPEC, {
              actorId: user.id,
              payload: { itemType: 'Part', marker: 'm' },
            })
          })
        },
        3,
        ['40001', '40P01', '23505'],
      ).catch((e: unknown) => e)

      expect(attempts).toBe(1)
      expect(error).toBeInstanceOf(ExtensionDispatchError)
      // The original is reachable for diagnosis, but not under `cause`, which
      // is the path `pgErrorCode` walks.
      expect((error as ExtensionDispatchError).extensionError).toMatchObject({
        code: '23505',
      })
      expect((error as { cause?: unknown }).cause).toBeUndefined()
    })
  })

  /* ---------------------------------------------------------------- *
   * enablement
   * ---------------------------------------------------------------- */

  describe('enablement', () => {
    it('does not run an extension disabled by its own declaration', async () => {
      const ran: Array<string> = []
      defineExtension({
        id: 'test.declared-off',
        on: SPEC,
        phase: 'in-transaction',
        enabled: false,
        handler: ({ event }) => {
          ran.push(event.payload.marker)
          return Promise.resolve()
        },
      })

      await publish()
      expect(ran).toEqual([])
    })

    it('does not run an extension an operator switched off', async () => {
      const ran: Array<string> = []
      defineExtension({
        id: 'test.switched-off',
        on: SPEC,
        phase: 'in-transaction',
        handler: ({ event }) => {
          ran.push(event.payload.marker)
          return Promise.resolve()
        },
      })
      await testDb.db.insert(settings).values({
        key: EXTENSIONS_DISABLED_SETTING_KEY,
        jsonValue: ['test.switched-off'],
        modifiedBy: user.id,
      })
      resetExtensionEnablementCache()

      await publish()
      expect(ran).toEqual([])
    })

    /**
     * The lookup has to genuinely fail for this to prove anything. It used to
     * patch `select` onto `db`, which is a proxy that never sees the write — so
     * the lookup succeeded, and the assertion held whether or not failing open
     * worked.
     */
    it('fails open when the enablement lookup itself fails', async () => {
      resetExtensionEnablementCache()
      const read = vi
        .spyOn(enablementSource, 'read')
        .mockRejectedValue(new Error('database is unreachable'))
      try {
        await expect(
          isExtensionEnabled({
            id: 'test.fails-open',
            phase: 'in-transaction',
          }),
        ).resolves.toBe(true)
        expect(read).toHaveBeenCalledTimes(1)
      } finally {
        read.mockRestore()
        resetExtensionEnablementCache()
      }
    })

    /**
     * A predicate that cannot say whether an extension belongs here is no
     * warrant to refuse a user's write or to join its transaction, so a guard
     * or in-transaction extension whose predicate throws sits the write out.
     */
    it('does not run a guard or in-transaction extension whose own predicate throws', async () => {
      const ran: Array<string> = []
      defineExtension({
        id: 'test.predicate-throws',
        on: SPEC,
        phase: 'in-transaction',
        enabled: () => {
          throw new Error('licence lookup failed')
        },
        handler: ({ event }) => {
          ran.push(event.payload.marker)
          return Promise.resolve()
        },
      })

      await publish()
      expect(ran).toEqual([])
      await expect(
        isExtensionEnabled({
          id: 'test.throwing-guard',
          phase: 'guard',
          enabled: () => {
            throw new Error('licence lookup failed')
          },
        }),
      ).resolves.toBe(false)
    })

    /**
     * ...while a consumed extension runs, so its handler fails as well and the
     * failure lands on its cursor row: a consumer that sat out would stop for a
     * reason nothing reports.
     */
    it('treats a consumed extension whose own predicate throws as enabled', async () => {
      await expect(
        isExtensionEnabled({
          id: 'test.throwing-consumer',
          phase: 'consumed',
          enabled: () => {
            throw new Error('licence lookup failed')
          },
        }),
      ).resolves.toBe(true)
    })

    it('caches: many dispatches do not become many queries', async () => {
      defineExtension({
        id: 'test.cached',
        on: SPEC,
        phase: 'in-transaction',
        handler: () => Promise.resolve(),
      })
      resetExtensionEnablementCache()

      for (let i = 0; i < 5; i++) await publish(`m${i}`)

      // One read for the burst, not one per dispatch. The per-dispatch
      // enablement lookup is the obvious way to break the promise that the
      // community edition does not pay for a feature it does not use.
      expect(extensionEnablementLoadCount()).toBe(1)
    })
  })

  /* ---------------------------------------------------------------- *
   * registration-time validation
   * ---------------------------------------------------------------- */

  describe('registration', () => {
    it('throws when `on` names a type no definition claims', () => {
      expect(() => {
        defineExtension({
          id: 'test.unknown-type',
          phase: 'consumed',
          on: {
            type: 'test.extensions.never-defined',
            schemaVersion: 1,
            description: 'never registered',
            payloadSchema: z.object({}),
          },
          handler: () => Promise.resolve(),
        })
      }).toThrow(/unknown event type/)
    })
  })

  /* ---------------------------------------------------------------- *
   * amplification
   * ---------------------------------------------------------------- */

  describe('hop cap', () => {
    it('refuses a chain past the cap, and names it', async () => {
      // Build a causation chain by hand, one event per hop, then ask the
      // dispatcher to stamp one more.
      const { stampCausation } = await import('./dispatch')
      let previous = await publish('hop-0')
      for (let hop = 1; hop <= EXTENSION_HOP_CAP; hop++) {
        const stamped = await stampCausation(testDb.db, SPEC.type, {
          id: previous.id,
          correlationId: previous.correlationId,
        }).catch((e: unknown) => e)
        if (hop === EXTENSION_HOP_CAP) {
          expect(stamped).toBeInstanceOf(Error)
          expect((stamped as Error).message).toContain('extension-caused chain')
          expect((stamped as Error).message).toContain(SPEC.type)
          return
        }
        const { causationId, correlationId } = stamped as {
          causationId: string
          correlationId: string | undefined
        }
        previous = await testDb.db.transaction((tx) =>
          publishDomainEvent(tx, SPEC, {
            actorId: user.id,
            payload: { itemType: 'Part', marker: `hop-${hop}` },
            causationId,
            correlationId,
          }),
        )
      }
      throw new Error('the cap was never reached')
    })

    it('stamps causation and inherits the correlation id', async () => {
      const { stampCausation } = await import('./dispatch')
      const root = await testDb.db.transaction((tx) =>
        publishDomainEvent(tx, SPEC, {
          actorId: user.id,
          payload: { itemType: 'Part', marker: 'root' },
          correlationId: user.id,
        }),
      )

      const stamped = await stampCausation(testDb.db, SPEC.type, {
        id: root.id,
        correlationId: root.correlationId,
      })

      expect(stamped.causationId).toBe(root.id)
      expect(stamped.correlationId).toBe(user.id)
    })
  })
})
