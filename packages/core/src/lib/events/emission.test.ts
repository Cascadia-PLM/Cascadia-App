// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Emission-site invariants: the service layer actually records its facts.
 *
 * Gate 1 (data integrity): a fact must commit with the write it describes —
 * `design.released` with the merge, a lock's release with the release or
 * cancellation that performed it — because downstream systems (ERP sync,
 * webhooks) key on them, and the whole point of the transactional outbox is
 * that the log cannot diverge from the data. Fixture shape mirrors
 * ChangeOrderMergeService.test.ts.
 *
 * These run on the gate harness, where nothing commits and no event has a
 * `seq`: a test that needs an order has to read it from something else, or
 * not depend on one.
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
import { and, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { DesignReleasedPayload, ItemCreatedPayload } from '@/lib/events'
import { ItemService } from '@/lib/items/services/ItemService'
import { ChangeOrderService } from '@/lib/items/services/ChangeOrderService'
import { LifecycleInstanceService } from '@/lib/lifecycles/LifecycleInstanceService'
import { CheckoutService } from '@/lib/services/CheckoutService'
import { FileService } from '@/lib/vault/services/FileService'
import { defineDomainEvent, publishDomainEvent } from '@/lib/events'
import { ChangeOrderMergeService } from '@/lib/services/ChangeOrderMergeService'
import { BranchService } from '@/lib/services/BranchService'
import { DesignService } from '@/lib/services/DesignService'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  changeOrderDesigns,
  domainEvents,
  lifecycleDefinitions,
  lifecycleInstances,
  programs,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

const FINALIZE_SPEC = defineDomainEvent({
  type: 'test.events.finalize_spec',
  schemaVersion: 1,
  description: 'Test-only event for the transition afterFinalize hook',
  payloadSchema: z.object({ marker: z.string() }),
})

// Unique to this file — avoids races with other files' ECO workflows.
const EMISSION_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000299'

describe('domain event emission', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    await testDb.db
      .insert(lifecycleDefinitions)
      .values({
        id: EMISSION_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - EventEmission',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'Released',
              name: 'Released',
              isInitial: false,
              isFinal: true,
              finalKind: 'release',
            },
          ],
          transitions: [
            {
              id: 't1',
              name: 'Release',
              fromStateId: 'Draft',
              toStateId: 'Released',
            },
          ],
          applicableItemTypes: ['ChangeOrder'],
        },
        isActive: true,
        lifecycleType: 'Driving',
      })
      .onConflictDoNothing()

    await ItemTypeRegistry.reload()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
    uniquePrefix = `EV${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    user = await insertTestUser(testDb.db)
    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Event Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    const design = await DesignService.create(
      {
        programId: program.id,
        name: 'Event Test Design',
        code: `DESIGN-${uniquePrefix}`,
        designType: 'Engineering',
      },
      user.id,
    )
    designId = design.id!
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  it('ItemService.create emits item.created with the new master identity', async () => {
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-created`,
        revision: 'A',
        name: 'Event Emission Part',
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'item.created'),
          eq(domainEvents.subjectId, part.id),
        ),
      )
    expect(rows).toHaveLength(1)
    const event = rows[0]!
    expect(event.subjectMasterId).toBe(part.masterId)
    expect(event.actorId).toBe(user.id)
    expect(event.designId).toBe(designId)

    const payload = event.payload as ItemCreatedPayload
    expect(payload.itemNumber).toBe(`PN-${uniquePrefix}-created`)
    expect(payload.itemType).toBe('Part')
    expect(payload.masterId).toBe(part.masterId)
  })

  it('mergeBranchToMain emits design.released inside the merge', async () => {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Event Emission ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Event spike',
      } as any,
      user.id,
    )
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: EMISSION_TEST_WORKFLOW_ID,
      itemId: eco.id,
      currentState: 'Draft',
    })

    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      eco.id,
      user.id,
    )

    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-released`,
        revision: '-',
        name: 'Part released by event ECO',
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
    await testDb.db.insert(branchItems).values({
      branchId: branch.id,
      itemMasterId: part.masterId!,
      currentItemId: part.id,
      baseItemId: null,
      changeType: 'added',
    })

    const result = await ChangeOrderMergeService.mergeBranchToMain(
      branch.id,
      eco.id,
      user.id,
    )

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'design.released'),
          eq(domainEvents.subjectId, designId),
        ),
      )
    expect(rows).toHaveLength(1)
    const event = rows[0]!
    expect(event.actorId).toBe(user.id)
    expect(event.designId).toBe(designId)
    expect(event.branchId).toBe(branch.id)

    const payload = event.payload as DesignReleasedPayload
    expect(payload.changeOrderId).toBe(eco.id)
    expect(payload.designId).toBe(designId)
    expect(payload.branchId).toBe(branch.id)
    expect(payload.mergeCommitId).toBe(result.mergeCommit.id)
    expect(payload.revisionsAssigned[part.itemNumber!]).toBe('A')
    expect(payload.items).toHaveLength(1)
    expect(payload.items[0]).toMatchObject({
      masterId: part.masterId,
      itemNumber: part.itemNumber,
      itemType: 'Part',
      previousRevision: '',
      newRevision: 'A',
      changeType: 'added',
    })

    // Every event of one release is correlated by the change order's id,
    // and merged branch content carries no affected-item action.
    expect(event.correlationId).toBe(eco.id)
    expect(payload.items[0]?.action).toBeNull()
    expect(payload.items[0]?.itemId).toEqual(expect.any(String))

    // The ECO branch the fixture created recorded its own fact.
    const branchEvents = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'branch.created'),
          eq(domainEvents.subjectId, branch.id),
        ),
      )
    expect(branchEvents).toHaveLength(1)
    expect(branchEvents[0]!.payload).toMatchObject({
      branchId: branch.id,
      designId,
      branchType: 'eco',
      changeOrderItemId: eco.id,
    })

    // The merge's own outcome and the event agree — same transaction.
    expect(result.revisionsAssigned[part.itemNumber!]).toBe('A')

    // The per-item fact rides the same transaction, keyed by stable master
    // identity, and lands before the design summary that carried it.
    const itemEvents = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'item.released'),
          eq(domainEvents.subjectMasterId, part.masterId),
        ),
      )
    expect(itemEvents).toHaveLength(1)
    const itemEvent = itemEvents[0]!
    expect(itemEvent.actorId).toBe(user.id)
    expect(itemEvent.branchId).toBe(branch.id)
    expect(itemEvent.payload).toMatchObject({
      changeOrderId: eco.id,
      designId,
      masterId: part.masterId,
      itemNumber: part.itemNumber,
      itemType: 'Part',
      previousRevision: '',
      newRevision: 'A',
      changeType: 'added',
    })
  })

  it('LifecycleInstanceService.transition emits lifecycle.transitioned carrying the target state flags', async () => {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Event Emission Transition ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Event spike',
      } as any,
      user.id,
    )
    const instance = takeFirst(
      await testDb.db
        .insert(lifecycleInstances)
        .values({
          workflowDefinitionId: EMISSION_TEST_WORKFLOW_ID,
          itemId: eco.id,
          currentState: 'Draft',
        })
        .returning(),
    )

    const result = await LifecycleInstanceService.transition(
      instance.id,
      'Released',
      user.id,
      'spike',
    )
    expect(result.success).toBe(true)

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'lifecycle.transitioned'),
          eq(domainEvents.subjectId, eco.id),
        ),
      )
    expect(rows).toHaveLength(1)
    const event = rows[0]!
    expect(event.actorId).toBe(user.id)
    expect(event.subjectMasterId).toBe(eco.masterId)

    // Flags, never names: a consumer keys on finalKind to learn that this
    // change order released, whatever the state happens to be called.
    expect(event.payload).toMatchObject({
      instanceId: instance.id,
      itemId: eco.id,
      itemType: 'ChangeOrder',
      fromState: 'Draft',
      toState: 'Released',
      toStateIsFinal: true,
      toStateFinalKind: 'release',
      fromStateIsInitial: true,
      toStateIsInitial: false,
      action: 'Release',
      comments: 'spike',
    })

    // The item row moved in the same transaction the event was written in.
    const item = await ItemService.findById(eco.id)
    expect(item?.state).toBe('Released')
  })
  it('ItemService.update emits item.updated naming the changed fields and the commit', async () => {
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-edited`,
        revision: 'A',
        name: 'Before edit',
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )

    const updated = await ItemService.update(
      part.id,
      { name: 'After edit' },
      user.id,
      // Emission is under test, not authorization: the internal bypasses.
      { bypassBranchProtection: true, skipAccessCheck: true },
    )
    expect(updated.name).toBe('After edit')

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'item.updated'),
          eq(domainEvents.subjectId, part.id),
        ),
      )
    expect(rows).toHaveLength(1)
    const event = rows[0]!
    expect(event.actorId).toBe(user.id)
    expect(event.subjectMasterId).toBe(part.masterId)
    expect(event.payload).toMatchObject({
      itemId: part.id,
      itemType: 'Part',
      name: 'After edit',
      changedFields: ['name'],
    })
    // The values live on the commit the event points at.
    expect((event.payload as { commitId: string | null }).commitId).toEqual(
      expect.any(String),
    )

    // A save that changes nothing is not a fact.
    await ItemService.update(part.id, { name: 'After edit' }, user.id, {
      bypassBranchProtection: true,
      skipAccessCheck: true,
    })
    const again = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'item.updated'),
          eq(domainEvents.subjectId, part.id),
        ),
      )
    expect(again).toHaveLength(1)
  })

  it('ItemService.delete emits item.deleted with the row and the fact together', async () => {
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-deleted`,
        revision: 'A',
        name: 'Doomed',
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )

    await ItemService.delete(part.id, user.id, { skipAccessCheck: true })

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(
        and(
          eq(domainEvents.type, 'item.deleted'),
          eq(domainEvents.subjectId, part.id),
        ),
      )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.payload).toMatchObject({
      itemId: part.id,
      masterId: part.masterId,
      itemType: 'Part',
      itemNumber: part.itemNumber,
    })
    expect(await ItemService.findById(part.id)).toBeNull()
  })

  it('checkout, check-in and cancel each record their lock change on the branch', async () => {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Event Emission Checkout ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Event spike',
      } as any,
      user.id,
    )
    await testDb.db.insert(lifecycleInstances).values({
      workflowDefinitionId: EMISSION_TEST_WORKFLOW_ID,
      itemId: eco.id,
      currentState: 'Draft',
    })
    const { branch } = await BranchService.getOrCreateChangeOrderBranch(
      designId,
      eco.id,
      user.id,
    )
    const part = await ItemService.create(
      'Part',
      {
        itemNumber: `PN-${uniquePrefix}-locked`,
        revision: '-',
        name: 'Lockable part',
        designId,
        state: 'Draft',
      } as any,
      user.id,
    )
    // A tracked-but-unlocked row, as the branch would hold after a save.
    await testDb.db.insert(branchItems).values({
      branchId: branch.id,
      itemMasterId: part.masterId!,
      currentItemId: part.id,
      baseItemId: null,
      changeType: 'added',
    })

    const eventsOf = async (type: string) =>
      testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, type),
            eq(domainEvents.subjectMasterId, part.masterId),
          ),
        )

    await CheckoutService.checkout(
      { branchId: branch.id, itemMasterId: part.masterId! },
      user.id,
    )
    const checkedOut = await eventsOf('item.checked_out')
    expect(checkedOut).toHaveLength(1)
    expect(checkedOut[0]!.actorId).toBe(user.id)
    expect(checkedOut[0]!.payload).toMatchObject({
      itemMasterId: part.masterId,
      branchId: branch.id,
      designId,
    })

    await CheckoutService.checkin(part.masterId, branch.id, user.id)
    expect(await eventsOf('item.checked_in')).toHaveLength(1)

    await CheckoutService.checkout(
      { branchId: branch.id, itemMasterId: part.masterId! },
      user.id,
    )
    await CheckoutService.cancelCheckout(part.masterId, branch.id, user.id)
    expect(await eventsOf('item.checked_out')).toHaveLength(2)
    expect(await eventsOf('item.checkout_cancelled')).toHaveLength(1)
  })

  /**
   * The parity these close. Every one of these paths recorded nothing before,
   * and in each case the *other* arm of the same user action did record
   * something — so whether a fact existed was decided by which code path the
   * caller happened to take, which is exactly the kind of stream no rule can
   * be written against.
   */
  describe('coverage holes', () => {
    /** A branch to mint drafts on, with its ECO. */
    async function branchFor(label: string) {
      const eco = await ItemService.create(
        'ChangeOrder',
        {
          revision: '-',
          name: `Event Emission ${label} ECO`,
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Coverage',
        } as any,
        user.id,
      )
      await testDb.db.insert(lifecycleInstances).values({
        workflowDefinitionId: EMISSION_TEST_WORKFLOW_ID,
        itemId: eco.id,
        currentState: 'Draft',
      })
      const { branch } = await BranchService.getOrCreateChangeOrderBranch(
        designId,
        eco.id,
        user.id,
      )
      return branch
    }

    const eventsForMaster = async (type: string, masterId: string) =>
      testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, type),
            eq(domainEvents.subjectMasterId, masterId),
          ),
        )

    it('createOnBranch emits item.created, as ItemService.create does', async () => {
      const branch = await branchFor('CreateOnBranch')

      const { item } = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-${uniquePrefix}-branchborn`,
          itemType: 'Part',
          name: 'Branch-born part',
        },
        branch.id,
        'Create on branch',
        user.id,
      )

      // Exactly one, and it says where it was born — which is what lets a
      // consumer tell a branch-born master from a main-born one rather than
      // having to infer it.
      const created = await eventsForMaster('item.created', item.masterId)
      expect(created).toHaveLength(1)
      expect(created[0]!.actorId).toBe(user.id)
      expect(created[0]!.branchId).toBe(branch.id)
      expect(created[0]!.payload).toMatchObject({
        itemId: item.id,
        masterId: item.masterId,
        itemType: 'Part',
      })
    })

    it('deleting a branch-added draft emits item.deleted', async () => {
      const branch = await branchFor('DeleteOnBranch')
      const { item } = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-${uniquePrefix}-doomed`,
          itemType: 'Part',
          name: 'Doomed draft',
        },
        branch.id,
        'Create on branch',
        user.id,
      )

      await CheckoutService.deleteOnBranch(
        item.masterId,
        branch.id,
        'Delete on branch',
        user.id,
      )

      // Its birth was on the bus, so its death has to be too: a master created
      // and destroyed entirely on one branch would otherwise leave every
      // consumer's projection carrying it forever.
      const deleted = await eventsForMaster('item.deleted', item.masterId)
      expect(deleted).toHaveLength(1)
      expect(deleted[0]!.actorId).toBe(user.id)
      expect(deleted[0]!.branchId).toBe(branch.id)
    })

    it('the first save on a branch emits item.updated, like the second', async () => {
      const branch = await branchFor('FirstSave')
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-firstsave`,
          revision: '-',
          name: 'First save part',
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )
      await CheckoutService.checkout(
        { branchId: branch.id, itemMasterId: part.masterId! },
        user.id,
      )

      // The mint arm: the first content save, which used to be silent.
      await CheckoutService.saveChanges(
        {
          branchId: branch.id,
          itemId: part.id,
          changes: { name: 'Renamed once' },
          commitMessage: 'First save',
        },
        user.id,
      )
      const afterFirst = await eventsForMaster('item.updated', part.masterId)
      expect(afterFirst).toHaveLength(1)

      // The in-place arm: the second save of the same field, which always did.
      await CheckoutService.saveChanges(
        {
          branchId: branch.id,
          itemId: part.id,
          changes: { name: 'Renamed twice' },
          commitMessage: 'Second save',
        },
        user.id,
      )
      const afterSecond = await eventsForMaster('item.updated', part.masterId)
      expect(afterSecond).toHaveLength(2)

      // Parity is the whole point: the same user action through two arms has
      // to describe itself the same way. `revision` and `state` are filtered
      // out of the mint arm precisely so this holds — the field-change
      // computation reports a base-to-placeholder revision change there that
      // the in-place arm never sees.
      // Both saves changed only the name, so the two facts are compared
      // without an order: nothing on this harness has a `seq` to sort by.
      const changedFields = afterSecond.map(
        (row) =>
          (row.payload as { changedFields: Array<string> }).changedFields,
      )
      expect(changedFields).toEqual([['name'], ['name']])
    })

    it('replaceContent emits file.checked_in naming the version it supersedes', async () => {
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-filerewrite`,
          revision: '-',
          name: 'File rewrite part',
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )
      const uploaded = await FileService.uploadFile({
        itemId: part.id,
        file: Buffer.from('original bytes'),
        metadata: {
          originalFileName: 'spec.txt',
          mimeType: 'text/plain',
          size: 14,
        },
        uploadedBy: user.id,
      })

      await FileService.replaceContent({
        fileId: uploaded.id,
        data: Buffer.from('rewritten bytes'),
        userId: user.id,
        action: 'watermark',
      })

      // This is the path the superseded-watermark job and the signed release
      // PDF writer both take, so the artefact an audit consumer most needs was
      // the one that never reached the log.
      const checkedIn = await testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, 'file.checked_in'),
            eq(domainEvents.subjectId, part.id),
          ),
        )
      expect(checkedIn).toHaveLength(1)
      expect(checkedIn[0]!.payload).toMatchObject({
        previousFileId: uploaded.id,
        fileVersion: 2,
      })
    })

    it('restoring a deleted file records it, and every file fact names the item master', async () => {
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-filerestore`,
          revision: '-',
          name: 'File restore part',
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )
      const uploaded = await FileService.uploadFile({
        itemId: part.id,
        file: Buffer.from('restorable bytes'),
        metadata: {
          originalFileName: 'restore.txt',
          mimeType: 'text/plain',
          size: 16,
        },
        uploadedBy: user.id,
      })

      await FileService.deleteFile(uploaded.id, user.id)
      await FileService.restoreFile(uploaded.id, user.id)

      // A consumer that honoured the deletion would otherwise keep the file
      // gone for good.
      const facts = await testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            inArray(domainEvents.type, [
              'file.uploaded',
              'file.deleted',
              'file.restored',
            ]),
            eq(domainEvents.subjectId, part.id),
          ),
        )
      expect(facts.map((fact) => fact.type).sort()).toEqual([
        'file.deleted',
        'file.restored',
        'file.uploaded',
      ])
      // The master is what follows a file across revisions; the design is
      // what lets a program-scoped subscription match a file fact at all.
      for (const fact of facts) {
        expect(fact.subjectMasterId).toBe(part.masterId)
        expect(fact.designId).toBe(designId)
        expect(fact.payload).toMatchObject({
          fileId: uploaded.id,
          itemMasterId: part.masterId,
        })
      }
    })

    /** A part tracked on a branch, its lock held by the test user. */
    async function lockedOn(branchId: string, label: string) {
      const part = await ItemService.create(
        'Part',
        {
          itemNumber: `PN-${uniquePrefix}-${label}`,
          revision: '-',
          name: `Locked ${label}`,
          designId,
          state: 'Draft',
        } as any,
        user.id,
      )
      await testDb.db.insert(branchItems).values({
        branchId,
        itemMasterId: part.masterId!,
        currentItemId: part.id,
        baseItemId: null,
        changeType: 'added',
        checkedOutBy: user.id,
        checkedOutAt: new Date(),
      })
      return part
    }

    it('a release checks in every lock on its branch, inside the merge', async () => {
      const branch = await branchFor('ReleaseLocks')
      const part = await lockedOn(branch.id, 'releaselock')

      await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        branch.changeOrderItemId!,
        user.id,
      )

      // One check-in per lock the release cleared, by its holder and on the
      // branch, so a projection of who holds what lets it go.
      const checkedIn = await eventsForMaster('item.checked_in', part.masterId)
      expect(checkedIn).toHaveLength(1)
      expect(checkedIn[0]!.actorId).toBe(user.id)
      expect(checkedIn[0]!.branchId).toBe(branch.id)
    })

    it('cancelling a change order cancels the locks on its branches and archives them', async () => {
      const branch = await branchFor('CancelLocks')
      const part = await lockedOn(branch.id, 'cancellock')
      await testDb.db.insert(changeOrderDesigns).values({
        changeOrderId: branch.changeOrderItemId!,
        designId,
        branchId: branch.id,
        mergeStatus: 'pending',
      })

      await ChangeOrderService.cancel(branch.changeOrderItemId!, user.id)

      // The edits under the lock are discarded with the branch, so the lock's
      // end is a cancellation, by its holder.
      const cancelled = await eventsForMaster(
        'item.checkout_cancelled',
        part.masterId,
      )
      expect(cancelled).toHaveLength(1)
      expect(cancelled[0]!.actorId).toBe(user.id)
      expect(cancelled[0]!.branchId).toBe(branch.id)

      const archived = await testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, 'branch.archived'),
            eq(domainEvents.subjectId, branch.id),
          ),
        )
      expect(archived).toHaveLength(1)
      expect((await BranchService.getById(branch.id))?.isArchived).toBe(true)
    })

    /** A workspace holding one draft, its lock held by the test user. */
    async function lockedWorkspaceDraft(label: string) {
      const workspace = await BranchService.createWorkspaceBranch(
        designId,
        user.id,
        `ws-${label}-${uniquePrefix}`,
      )
      const { item } = await CheckoutService.createOnBranch(
        {
          designId,
          itemNumber: `PN-${uniquePrefix}-${label}`,
          itemType: 'Part',
          name: `Workspace draft ${label}`,
        },
        workspace.id,
        'Draft on workspace',
        user.id,
      )
      await testDb.db
        .update(branchItems)
        .set({ checkedOutBy: user.id, checkedOutAt: new Date() })
        .where(
          and(
            eq(branchItems.branchId, workspace.id),
            eq(branchItems.itemMasterId, item.masterId),
          ),
        )
      return { workspace, item }
    }

    it('deleting a workspace records its archive, its discarded drafts and its released locks', async () => {
      const { workspace, item } = await lockedWorkspaceDraft('wsdelete')

      await BranchService.deleteWorkspaceBranch(workspace.id, user.id)

      // The draft's birth was on the bus, so its end is; the archive is a fact
      // with the owner as its actor rather than a silent update; and the lock
      // is released rather than left behind on an archived branch.
      const deleted = await eventsForMaster('item.deleted', item.masterId)
      expect(deleted).toHaveLength(1)
      expect(deleted[0]!.branchId).toBe(workspace.id)
      expect(
        await eventsForMaster('item.checkout_cancelled', item.masterId),
      ).toHaveLength(1)
      const archived = await testDb.db
        .select()
        .from(domainEvents)
        .where(
          and(
            eq(domainEvents.type, 'branch.archived'),
            eq(domainEvents.subjectId, workspace.id),
          ),
        )
      expect(archived).toHaveLength(1)
      expect(archived[0]!.actorId).toBe(user.id)
    })

    it('removing a workspace draft records the draft deleted and its lock cancelled', async () => {
      const { workspace, item } = await lockedWorkspaceDraft('wsremove')

      await BranchService.removeWorkspaceItem(
        workspace.id,
        item.masterId,
        user.id,
      )

      expect(await eventsForMaster('item.deleted', item.masterId)).toHaveLength(
        1,
      )
      expect(
        await eventsForMaster('item.checkout_cancelled', item.masterId),
      ).toHaveLength(1)
    })

    it('a lock adopted with its row is checked in on the workspace and out on the change order branch', async () => {
      const eco = await ItemService.create(
        'ChangeOrder',
        {
          revision: '-',
          name: 'Event Emission Adoption ECO',
          changeType: 'ECO',
          priority: 'medium',
          reasonForChange: 'Coverage',
        } as any,
        user.id,
      )
      await testDb.db.insert(lifecycleInstances).values({
        workflowDefinitionId: EMISSION_TEST_WORKFLOW_ID,
        itemId: eco.id,
        currentState: 'Draft',
      })
      const { workspace, item } = await lockedWorkspaceDraft('wsadopt')

      await ChangeOrderService.adoptWorkspaceItems(
        eco.id,
        workspace.id,
        user.id,
      )

      // The holder keeps the claim, on another branch: a check-in where the
      // row was, and a checkout where it now is.
      const [linked] = await ChangeOrderService.getChangeOrderDesigns(eco.id)
      const checkedIn = await eventsForMaster('item.checked_in', item.masterId)
      expect(checkedIn).toHaveLength(1)
      expect(checkedIn[0]!.branchId).toBe(workspace.id)
      expect(checkedIn[0]!.actorId).toBe(user.id)
      const checkedOut = await eventsForMaster(
        'item.checked_out',
        item.masterId,
      )
      expect(
        checkedOut.some(
          (fact) =>
            fact.branchId === linked?.branchId && fact.actorId === user.id,
        ),
      ).toBe(true)
    })
  })

  it("LifecycleInstanceService.transition runs the caller's afterFinalize hook inside the state-write transaction", async () => {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Event Emission Finalize ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Event spike',
      } as any,
      user.id,
    )
    const instance = takeFirst(
      await testDb.db
        .insert(lifecycleInstances)
        .values({
          workflowDefinitionId: EMISSION_TEST_WORKFLOW_ID,
          itemId: eco.id,
          currentState: 'Draft',
        })
        .returning(),
    )

    const result = await LifecycleInstanceService.transition(
      instance.id,
      'Released',
      user.id,
      undefined,
      {
        afterFinalize: async (tx) => {
          await publishDomainEvent(tx, FINALIZE_SPEC, {
            subject: { id: eco.id },
            payload: { marker: 'finalized' },
          })
        },
      },
    )
    expect(result.success).toBe(true)

    const rows = await testDb.db
      .select()
      .from(domainEvents)
      .where(eq(domainEvents.subjectId, eco.id))
    const types = rows.map((row) => row.type).sort()
    // Sorted, so the rename moved this entry: 'lifecycle.' sorts before
    // 'test.' where 'workflow.' sorted after it.
    expect(types).toEqual([
      'item.created',
      'lifecycle.transitioned',
      'test.events.finalize_spec',
    ])
  })
})
