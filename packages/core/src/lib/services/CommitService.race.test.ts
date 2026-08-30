// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Commit creation under real concurrency
 *
 * Data-integrity gate. A commit is a read-then-write against one branch row:
 * `CommitService.create` reads `headCommitId`, parents the new commit on it,
 * and writes the new head. Every caller but `saveChanges` opens a plain READ
 * COMMITTED transaction, so two commits landing on one branch at once both
 * read the same head, both parent on it, and whichever head UPDATE runs second
 * wins. The loser's commit row survives — but nothing reaches it by walking
 * parents back from the branch head, so its item versions are gone from
 * history and the items it stamped point at a commit no longer on the branch.
 *
 * `createMergeCommit` had the same defect one level up: standalone it wraps
 * its body in `withSerializableRetry`, and the target-branch read used to sit
 * *outside* that loop — so a retry replayed the first attempt's head and
 * parented the merge commit on a commit another release had already
 * superseded.
 *
 * Neither test can exist under `TestDatabase`: one shared connection inside
 * one gate transaction cannot exercise a row lock, and a write made "by
 * someone else" between two attempts would roll back with the attempt. These
 * commit for real through `ConcurrentTestDatabase`, and the harness cleans up
 * after itself.
 *
 * Run: npx vitest run packages/core/src/lib/services/CommitService.race.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { eq } from 'drizzle-orm'
import { CommitService } from './CommitService'
import { BranchService } from './BranchService'
import type { TransactionClient } from '@/lib/db'
import { ConcurrentTestDatabase } from '@/__tests__/helpers/concurrent-db'
import { branches, commits } from '@/lib/db/schema'
import { takeFirst } from '@/lib/db/take-first'

describe('CommitService — commits on one branch under real concurrency', () => {
  const concurrent = new ConcurrentTestDatabase()

  beforeAll(() => {
    concurrent.setup()
  })

  afterAll(async () => {
    await concurrent.teardown()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await concurrent.cleanup()
  })

  /** A design and its main branch — the only fixture a commit needs. */
  async function seededMainBranch(label: string) {
    const { user, designId } = await concurrent.seedScope(label)
    const main = await BranchService.getMainBranch(designId)
    if (!main) throw new Error('main branch missing')
    return { user, designId, mainBranchId: main.id }
  }

  /**
   * The branch's history as every reader sees it: parents walked back from the
   * current head. Anything on the branch this walk does not visit is an
   * orphan, which is exactly what the lost update produced.
   */
  async function chainFromHead(branchId: string) {
    const branch = await BranchService.getById(branchId)
    if (!branch) throw new Error('branch missing')

    const rows = await concurrent.db
      .select()
      .from(commits)
      .where(eq(commits.branchId, branchId))
    const byId = new Map(rows.map((row) => [row.id, row]))

    const walked: Array<string> = []
    const seen = new Set<string>()
    let cursor: string | null = branch.headCommitId
    while (cursor !== null && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      walked.push(cursor)
      cursor = byId.get(cursor)?.parentId ?? null
    }

    return { head: branch.headCommitId, walked, onBranch: rows }
  }

  it('leaves no commit unreachable when several land on one branch at once', async () => {
    const { user, mainBranchId } = await seededMainBranch('commit-race')

    // Four, not five: the pool holds five connections and the fifth is the
    // spare the harness documents. Each of these is a real transaction on a
    // connection of its own, so the head reads genuinely overlap.
    const concurrentCommits = 4
    const created = await Promise.all(
      Array.from({ length: concurrentCommits }, (_, i) =>
        CommitService.create(
          {
            branchId: mainBranchId,
            message: `concurrent commit ${i}`,
            itemChanges: [],
          },
          user.id,
        ),
      ),
    )

    const { head, walked, onBranch } = await chainFromHead(mainBranchId)

    // One unbroken chain: the design's initial commit plus every commit just
    // created, and nothing on the branch the walk missed.
    expect(onBranch).toHaveLength(concurrentCommits + 1)
    expect(walked).toHaveLength(onBranch.length)
    expect(new Set(walked).size).toBe(walked.length)

    // Every created commit is on it. Which one ended up as the head is
    // timing's choice and never asserted — only that the head is one of them.
    for (const commit of created) {
      expect(walked).toContain(commit.id)
    }
    expect(created.map((c) => c.id)).toContain(head)

    // Nothing parented twice: a lost update leaves two commits sharing one
    // parent, which is how the orphan gets stranded.
    const parents = onBranch
      .map((row) => row.parentId)
      .filter((id): id is string => id !== null)
    expect(new Set(parents).size).toBe(parents.length)
  })

  it('parents a retried merge commit on the head the retry re-read', async () => {
    const { user, designId, mainBranchId } =
      await seededMainBranch('merge-commit-race')
    const source = await BranchService.createWorkspaceBranch(
      designId,
      user.id,
      'merge-retry-source',
    )
    const baseHead = (await BranchService.getById(mainBranchId))?.headCommitId

    // The head another release will have moved main to by the time the retry
    // runs. Written now, pointed at below: making it the head here would leave
    // the two implementations nothing to disagree about.
    const supersedingHead = takeFirst(
      await concurrent.db
        .insert(commits)
        .values({
          designId,
          branchId: mainBranchId,
          parentId: baseHead,
          message: 'landed while the merge was retrying',
          createdBy: user.id,
        })
        .returning(),
      'commit',
    )

    // Fail the first attempt at its very first statement — before it has taken
    // any lock on the branch row, so the "other release" is free to move the
    // head — with the code `withSerializableRetry` retries on.
    const realGetByIdForUpdate =
      BranchService.getByIdForUpdate.bind(BranchService)
    let reads = 0
    const readSpy = vi
      .spyOn(BranchService, 'getByIdForUpdate')
      .mockImplementation(async (id: string, tx: TransactionClient) => {
        reads += 1
        if (reads === 1) {
          await concurrent.db
            .update(branches)
            .set({ headCommitId: supersedingHead.id })
            .where(eq(branches.id, mainBranchId))
          throw Object.assign(new Error('synthetic serialization failure'), {
            code: '40001',
          })
        }
        return realGetByIdForUpdate(id, tx)
      })

    const mergeCommit = await CommitService.createMergeCommit(
      {
        targetBranchId: mainBranchId,
        sourceBranchId: source.id,
        message: 'Merged workspace branch',
      },
      user.id,
    )

    // The read happens inside the retried body: attempt one and attempt two
    // each performed it.
    expect(readSpy.mock.calls.length).toBeGreaterThanOrEqual(2)

    // And it is the retry's answer that was used. Read once before the loop,
    // this would still be the head the superseding commit replaced.
    expect(mergeCommit.parentId).toBe(supersedingHead.id)
    expect(mergeCommit.parentId).not.toBe(baseHead)

    const { head, walked } = await chainFromHead(mainBranchId)
    expect(head).toBe(mergeCommit.id)
    expect(walked).toContain(supersedingHead.id)
  })
})
