// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Vault check-out and version-chain writes under real concurrency
 *
 * Data-integrity gate, twice over.
 *
 * A file check-out is the vault's mutual-exclusion primitive — the whole
 * reason it exists is that two people cannot merge a binary CAD file — and it
 * was acquired by reading the row, deciding in JavaScript that nobody held it,
 * and then writing `UPDATE … WHERE id = $1` unconditionally. Two callers
 * reaching that read together both passed it and both wrote. The second
 * overwrote the first with no error anywhere: two engineers each got a 200 and
 * each believed they held the exclusive lock, and whoever checked in second
 * silently discarded the other's work. The expired-lock branch was the same
 * shape one layer down — it released somebody else's stale lock from a read
 * taken earlier in the call, so a lock claimed in between could be cleared out
 * from under its brand-new owner.
 *
 * The version chain had the identical defect at the other end of the same
 * workflow. `checkInFile` and `replaceContent` each demoted the current head
 * with an unguarded UPDATE and then inserted a row claiming to be the new head,
 * as separate statements. Two writers reaching that together both demoted and
 * both inserted, leaving one chain with two rows flagged `isLatestVersion` and
 * carrying the same `fileVersion` — a state no reader models, so which bytes an
 * item's current drawing means comes down to row order. `replaceContent` also
 * demoted *before* storing the new blob, so a storage failure committed the
 * demote and then threw, leaving a file with no latest version at all.
 *
 * Neither family could be written before the concurrent harness existed.
 * `TestDatabase` runs every test on one connection inside one transaction, so
 * `Promise.all` over two service calls is a queue, not a race, and both bugs
 * look impossible. These use `ConcurrentTestDatabase`, which is a real pool —
 * so they commit, and the harness cleans up after itself.
 *
 * The check-out tests never touch storage: check-out and check-in without new
 * bytes are pure database work, so the vault rows are inserted directly. The
 * version-chain tests do write bytes, into a throwaway directory under the
 * OS temp dir — never the dev vault — because the ordering of the store
 * against the transaction is the point of half of them.
 *
 * Run: npx vitest run packages/core/src/lib/vault/services/FileService.race.test.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { and, eq } from 'drizzle-orm'
import { FileService } from './FileService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { FileUploadMetadata } from '@/lib/vault/storage'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { insertTestUserWithRole } from '@/__tests__/fixtures/users'
import { insertTestDocument } from '@/__tests__/fixtures/items'
import { vaultFileHistory, vaultFiles } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'
import { LocalFileStorage, StorageFactory } from '@/lib/vault/storage'
import {
  AppError,
  ConflictError,
  NotFoundError,
  ResourceLockedError,
  ValidationError,
} from '@/lib/errors'

const CONTENDERS = 8

/**
 * Fewer than the harness's five pooled connections. Every version-chain write
 * holds a connection for the length of its transaction, so a wider fan-out
 * would queue on the pool — restoring the serialization this file exists to
 * remove — rather than contend.
 */
const CHAIN_WRITERS = 4

/**
 * Old enough to be expired under any plausible `MAX_FILE_CHECKOUT_HOURS`.
 * The threshold is environment-configurable (24h by default), so a test that
 * sat just past the default would become a configuration trap.
 */
const LONG_EXPIRED = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)

/** The seeded row's name, so a check-in stays on the same chain. */
const FILE_NAME = 'housing.step'

const CHECKIN_METADATA: FileUploadMetadata = {
  originalFileName: FILE_NAME,
  mimeType: 'application/step',
  size: 64,
}

describe('FileService — vault writes under real concurrency', () => {
  const concurrent = new ConcurrentTestDatabase()

  let vaultRoot: string
  let storage: LocalFileStorage

  beforeAll(async () => {
    concurrent.setup()
    vaultRoot = await mkdtemp(join(tmpdir(), 'cascadia-vault-race-'))
    storage = new LocalFileStorage(vaultRoot)
  })

  afterAll(async () => {
    await concurrent.teardown()
    await rm(vaultRoot, { recursive: true, force: true })
  })

  beforeEach(() => {
    // Not `beforeAll`: `restoreMocks` in vitest.config.ts restores every spy
    // before each test, so a spy installed once for the file would be gone by
    // the time the first test ran.
    vi.spyOn(StorageFactory, 'createFromSettings').mockResolvedValue(storage)
  })

  afterEach(async () => {
    await concurrent.cleanup()
  })

  /** One vault row on a fresh item, and N users all entitled to lock it. */
  async function contendedFile(label: string) {
    const { user, designId } = await concurrent.seedScope(label)
    const { item } = await insertTestDocument(concurrent.db, designId, user.id)

    const contenders: Array<TestUser> = [user]
    for (let i = 1; i < CONTENDERS; i++) {
      const { user: extra } = await insertTestUserWithRole(
        concurrent.db,
        'User',
      )
      concurrent.trackUser(extra.id)
      contenders.push(extra)
    }

    const file = takeFirst(
      await concurrent.db
        .insert(vaultFiles)
        .values({
          itemId: item.id,
          fileName: FILE_NAME,
          originalFileName: FILE_NAME,
          fileSize: 2048,
          mimeType: 'application/step',
          fileHash: `hash-${item.id}`,
          storageType: 'local',
          storagePath: `race/${item.id}/${FILE_NAME}`,
          uploadedBy: user.id,
        })
        .returning(),
    )

    return { fileId: file.id, itemId: item.id, contenders }
  }

  async function rowFor(fileId: string) {
    return takeFirst(
      await concurrent.db
        .select()
        .from(vaultFiles)
        .where(eq(vaultFiles.id, fileId)),
    )
  }

  async function historyFor(fileId: string, action: string) {
    return concurrent.db
      .select()
      .from(vaultFileHistory)
      .where(
        and(
          eq(vaultFileHistory.fileId, fileId),
          eq(vaultFileHistory.action, action),
        ),
      )
  }

  /** Put the row into "held by this user, since this moment" directly. */
  async function forceLock(fileId: string, holderId: string, since: Date) {
    await concurrent.db
      .update(vaultFiles)
      .set({ isCheckedOut: true, checkedOutBy: holderId, checkedOutAt: since })
      .where(eq(vaultFiles.id, fileId))
  }

  describe('checkOutFile — concurrent acquisition', () => {
    it('gives the lock to exactly one of eight simultaneous callers', async () => {
      const { fileId, contenders } = await contendedFile('file-checkout-race')

      const outcomes = await Promise.allSettled(
        contenders.map((u) => FileService.checkOutFile(fileId, u.id)),
      )

      const winners = contenders.filter(
        (_, i) => outcomes[i]?.status === 'fulfilled',
      )
      expect(winners).toHaveLength(1)

      // The class, not the message — a loser must get the conflict the API
      // already models, never a raw driver error and never a quiet success.
      for (const loser of outcomes.filter((o) => o.status === 'rejected')) {
        expect(loser.reason).toBeInstanceOf(ResourceLockedError)
      }

      // The lock belongs to the caller that won, not to whoever wrote last.
      const row = await rowFor(fileId)
      expect(row.isCheckedOut).toBe(true)
      expect(row.checkedOutBy).toBe(winners[0]!.id)

      // One claim, so one entry: a checkout logged for a caller who never held
      // the lock is exactly the silent overwrite this refuses to allow.
      const logged = await historyFor(fileId, 'checkout')
      expect(logged).toHaveLength(1)
      expect(logged[0]?.performedBy).toBe(winners[0]!.id)
    })

    it('auto-releases an expired lock and claims it', async () => {
      const { fileId, contenders } = await contendedFile('file-expired-lock')
      const [holder, claimant] = contenders

      await forceLock(fileId, holder!.id, LONG_EXPIRED)

      await FileService.checkOutFile(fileId, claimant!.id)

      const row = await rowFor(fileId)
      expect(row.isCheckedOut).toBe(true)
      expect(row.checkedOutBy).toBe(claimant!.id)

      // Both halves stay on the record: the abandoned lock was unwound, and the
      // new one was taken. An auditor reading the history sees why the holder
      // changed without a check-in.
      expect(await historyFor(fileId, 'auto-expired')).toHaveLength(1)
      expect(await historyFor(fileId, 'checkout')).toHaveLength(1)
    })

    it('gives an expired lock to exactly one of eight simultaneous callers', async () => {
      // The auto-release path raced. Eight callers all read the same stale lock,
      // all concluded it was theirs to unwind, and the unconditional release
      // plus unconditional write handed the file to every one of them.
      const { fileId, contenders } = await contendedFile('file-expired-race')
      const { user: holder } = await insertTestUserWithRole(
        concurrent.db,
        'User',
      )
      concurrent.trackUser(holder.id)

      await forceLock(fileId, holder.id, LONG_EXPIRED)

      const outcomes = await Promise.allSettled(
        contenders.map((u) => FileService.checkOutFile(fileId, u.id)),
      )

      const winners = contenders.filter(
        (_, i) => outcomes[i]?.status === 'fulfilled',
      )
      expect(winners).toHaveLength(1)
      for (const loser of outcomes.filter((o) => o.status === 'rejected')) {
        expect(loser.reason).toBeInstanceOf(ResourceLockedError)
      }

      const row = await rowFor(fileId)
      expect(row.checkedOutBy).toBe(winners[0]!.id)
      expect(await historyFor(fileId, 'checkout')).toHaveLength(1)
    })

    it('refuses a second caller and lets the next one in after check-in', async () => {
      // The sequential contract the routes and the UI already depend on, pinned
      // so the compare-and-set cannot have turned a released lock into a
      // permanent refusal.
      const { fileId, contenders } = await contendedFile('file-sequential')
      const [first, second] = contenders

      await FileService.checkOutFile(fileId, first!.id)
      expect((await rowFor(fileId)).checkedOutBy).toBe(first!.id)

      await expect(
        FileService.checkOutFile(fileId, second!.id),
      ).rejects.toBeInstanceOf(ResourceLockedError)

      await FileService.checkInFile(fileId, first!.id)
      expect((await rowFor(fileId)).isCheckedOut).toBe(false)

      await FileService.checkOutFile(fileId, second!.id)
      expect((await rowFor(fileId)).checkedOutBy).toBe(second!.id)
    })

    it('still refuses a missing file and a deleted one', async () => {
      const { fileId, contenders } = await contendedFile('file-refusals')
      const [user] = contenders

      await expect(
        FileService.checkOutFile(crypto.randomUUID(), user!.id),
      ).rejects.toBeInstanceOf(NotFoundError)

      await concurrent.db
        .update(vaultFiles)
        .set({ deletedAt: new Date(), deletedBy: user!.id })
        .where(eq(vaultFiles.id, fileId))

      await expect(
        FileService.checkOutFile(fileId, user!.id),
      ).rejects.toBeInstanceOf(ValidationError)
      expect((await rowFor(fileId)).isCheckedOut).toBe(false)
    })
  })

  describe('version chain — concurrent supersession', () => {
    /** Every row of one chain, oldest first. Chains are keyed on name + item. */
    async function chainFor(itemId: string) {
      return concurrent.db
        .select()
        .from(vaultFiles)
        .where(
          and(
            eq(vaultFiles.itemId, itemId),
            eq(vaultFiles.fileName, FILE_NAME),
          ),
        )
        .orderBy(vaultFiles.fileVersion)
    }

    /**
     * The invariant every writer on this chain has to preserve: one head, and
     * version numbers that count 1, 2, 3… without a gap or a repeat. Both
     * halves are needed — the pre-fix double-insert produced two heads *and*
     * two rows numbered 2, and either alone is enough to make the history lie.
     */
    async function expectIntactChain(itemId: string, length: number) {
      const chain = await chainFor(itemId)
      expect(chain).toHaveLength(length)
      expect(chain.filter((row) => row.isLatestVersion)).toHaveLength(1)
      expect(chain.map((row) => row.fileVersion)).toEqual(
        chain.map((_, i) => i + 1),
      )
      // The head is the newest version, not an older row left flagged.
      expect(chain.at(-1)?.isLatestVersion).toBe(true)
      return chain
    }

    it('lets exactly one of four simultaneous rewrites take the chain head', async () => {
      // Four watermark/sign passes over one file — a re-released ECO fanning
      // out, or a job retried while its predecessor was still running. Before
      // the guarded demote, all four demoted the same row and all four inserted
      // a version 2 flagged latest.
      const { fileId, itemId, contenders } =
        await contendedFile('chain-replace-race')

      const outcomes = await Promise.allSettled(
        contenders.slice(0, CHAIN_WRITERS).map((user, i) =>
          FileService.replaceContent({
            fileId,
            data: Buffer.from(`stamped-${i}`),
            userId: user.id,
            action: 'watermark',
          }),
        ),
      )

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
      for (const loser of outcomes.filter((o) => o.status === 'rejected')) {
        expect(loser.reason).toBeInstanceOf(ConflictError)
      }

      await expectIntactChain(itemId, 2)
    })

    it('lets exactly one of two simultaneous check-ins take the chain head', async () => {
      // A double-submitted check-in: one holder, one lock, two uploads in
      // flight. Both used to demote and both used to insert a version 2.
      const { fileId, itemId, contenders } =
        await contendedFile('chain-checkin-race')
      const [holder] = contenders

      await FileService.checkOutFile(fileId, holder!.id)

      const outcomes = await Promise.allSettled([
        FileService.checkInFile(
          fileId,
          holder!.id,
          Buffer.from('revised-a'),
          CHECKIN_METADATA,
        ),
        FileService.checkInFile(
          fileId,
          holder!.id,
          Buffer.from('revised-b'),
          CHECKIN_METADATA,
        ),
      ])

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1)
      for (const loser of outcomes.filter((o) => o.status === 'rejected')) {
        expect(loser.reason).toBeInstanceOf(ConflictError)
      }

      await expectIntactChain(itemId, 2)
    })

    it('cannot let a check-in and a machine rewrite both take the head', async () => {
      // The mixed race the two paths make possible. It is one-sided by
      // construction — `checkInFile` needs the file checked out and
      // `replaceContent` refuses a file that is — so the rewrite is always the
      // loser, but *which* refusal it gets depends on the interleaving: a 423
      // if it read the row while the lock was still on it, a 400 if it read
      // after the check-in's transaction demoted it. Both are modelled
      // refusals; what must never happen is a second head.
      const { fileId, itemId, contenders } =
        await contendedFile('chain-mixed-race')
      const [holder] = contenders

      await FileService.checkOutFile(fileId, holder!.id)

      const [checkin, rewrite] = await Promise.allSettled([
        FileService.checkInFile(
          fileId,
          holder!.id,
          Buffer.from('revised'),
          CHECKIN_METADATA,
        ),
        FileService.replaceContent({
          fileId,
          data: Buffer.from('stamped'),
          userId: holder!.id,
          action: 'watermark',
        }),
      ])

      expect(checkin.status).toBe('fulfilled')
      expect(rewrite.status).toBe('rejected')
      if (rewrite.status === 'rejected') {
        expect(rewrite.reason).toBeInstanceOf(AppError)
      }

      await expectIntactChain(itemId, 2)
    })

    it('leaves no checkout lock on the version a check-in supersedes', async () => {
      // The demote used to clear only the two version flags, so the superseded
      // row kept `isCheckedOut` and its holder forever — a lock nobody could
      // ever check in, visible to the admin unlock list and swept every night
      // by `cleanupExpiredCheckouts`.
      const { fileId, itemId, contenders } =
        await contendedFile('chain-lock-residue')
      const [holder] = contenders

      await FileService.checkOutFile(fileId, holder!.id)
      await FileService.checkInFile(
        fileId,
        holder!.id,
        Buffer.from('revised'),
        CHECKIN_METADATA,
      )

      const superseded = await rowFor(fileId)
      expect(superseded.isLatestVersion).toBe(false)
      expect(superseded.isCheckedOut).toBe(false)
      expect(superseded.checkedOutBy).toBeNull()
      expect(superseded.checkedOutAt).toBeNull()

      await expectIntactChain(itemId, 2)
    })

    it('leaves the previous version as the head when the blob cannot be stored', async () => {
      // The ordering defect: `replaceContent` demoted first and stored second,
      // so a full disk or an S3 timeout committed the demote and then threw,
      // leaving the file with no latest version at all — invisible in the file
      // list and recoverable only by hand-editing the table.
      const { fileId, itemId } = await contendedFile('chain-store-fault')
      const store = vi
        .spyOn(storage, 'store')
        .mockRejectedValueOnce(new Error('vault volume is full'))

      // Message match on purpose: this is the sentinel this test injected,
      // and pinning it is how we know the run died where we aimed it.
      await expect(
        FileService.replaceContent({
          fileId,
          data: Buffer.from('stamped'),
          userId: (await rowFor(fileId)).uploadedBy,
          action: 'watermark',
        }),
      ).rejects.toThrow('vault volume is full')

      expect(store).toHaveBeenCalledTimes(1)

      const chain = await expectIntactChain(itemId, 1)
      expect(chain[0]?.id).toBe(fileId)
      expect(chain[0]?.fileVersion).toBe(1)
      expect(chain[0]?.isLatestVersion).toBe(true)
    })
  })
})
