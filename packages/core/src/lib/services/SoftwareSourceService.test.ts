// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * SoftwareSourceService Tests
 *
 * Data-integrity tests (three-gate rule) for the content-addressed source
 * store behind Software items:
 *  - blob deduplication (same content = same row, storage ∝ change)
 *  - manifest immutability (edits create new manifests, old ones untouched)
 *  - version-pinned manifests across the full checkout → edit → merge cycle
 *  - released revisions carry their extension row (manifest survives release)
 *
 * Run: npx vitest run src/lib/services/SoftwareSourceService.test.ts
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
import { and, eq, like } from 'drizzle-orm'
import { strToU8, zipSync } from 'fflate'
import { ItemService } from '../items/services/ItemService'
import { ChangeOrderService } from '../items/services/ChangeOrderService'
import { ChangeOrderMergeService } from './ChangeOrderMergeService'
import { CheckoutService } from './CheckoutService'
import { ConflictDetectionService } from './ConflictDetectionService'
import { SoftwareSourceService } from './SoftwareSourceService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Software } from '@/lib/items/types/software'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  branches,
  commits,
  itemFieldChanges,
  itemVersions,
  items,
  programMembers,
  programs,
  software,
  softwareBlobs,
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import {
  BranchProtectionError,
  ResourceLockedError,
  ValidationError,
} from '@/lib/errors'

// Import to register item types
import '@/lib/items/registerItemTypes.server'

// Well-known test workflow ID for the SoftwareSourceService ECO workflow
const SW_TEST_WORKFLOW_ID = '00000000-0000-4000-8000-000000000211'

describe('SoftwareSourceService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  let programId: string
  let designId: string
  let uniquePrefix: string

  beforeAll(async () => {
    await testDb.setup()
    await seedStandardPartLifecycle(testDb.db)

    // ECO workflow specific to this file — unique ID avoids races with other
    // test files that define their own ECO workflows.
    await testDb.db
      .insert(workflowDefinitions)
      .values({
        id: SW_TEST_WORKFLOW_ID,
        name: 'Test ECO Workflow - SoftwareSource',
        version: 1,
        workflowType: 'strict',
        definition: {
          states: [
            { id: 'Draft', name: 'Draft', isInitial: true, isFinal: false },
            {
              id: 'Approved',
              name: 'Approved',
              isInitial: false,
              isFinal: false,
            },
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
              name: 'Approve',
              fromStateId: 'Draft',
              toStateId: 'Approved',
            },
            {
              id: 't2',
              name: 'Release',
              fromStateId: 'Approved',
              toStateId: 'Released',
            },
          ],
          definitionType: 'workflow',
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

    uniquePrefix = `T${Date.now()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`

    user = await insertTestUser(testDb.db)

    const program = takeFirst(
      await testDb.db
        .insert(programs)
        .values({
          name: 'Test Program',
          code: `PROG-${uniquePrefix}`,
          createdBy: user.id,
        })
        .returning(),
    )
    programId = program.id

    // The program's creator is not automatically a member when the row is
    // inserted directly (ProgramService.create is what enrols them), and
    // ItemService.update/delete now refuse a write to a design the caller
    // cannot reach. Enrol the acting user so these cases exercise their own
    // subject rather than the program boundary.
    await testDb.db.insert(programMembers).values({
      programId,
      userId: user.id,
      role: 'admin',
      invitedBy: user.id,
    })

    const design = await DesignService.create(
      {
        programId,
        name: 'Test Design',
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

  // Helper: create an internal-mode Software item on (pre-release) main
  async function createSoftware(suffix = 'fw'): Promise<Software> {
    return ItemService.create<Software>(
      'Software',
      {
        itemNumber: `SW-${uniquePrefix}-${suffix}`,
        revision: 'A',
        name: `Test Firmware ${suffix}`,
        designId,
        state: 'Draft',
        itemType: 'Software',
        softwareType: 'firmware',
        sourceMode: 'internal',
      },
      user.id,
    )
  }

  // Helper: create an ECO with a workflow instance
  async function createChangeOrder() {
    const eco = await ItemService.create(
      'ChangeOrder',
      {
        revision: '-',
        name: 'Test ECO',
        changeType: 'ECO',
        priority: 'medium',
        reasonForChange: 'Test',
      } as any,
      user.id,
    )
    await testDb.db.insert(workflowInstances).values({
      workflowDefinitionId: SW_TEST_WORKFLOW_ID,
      itemId: eco.id,
      currentState: 'Draft',
    })
    return eco
  }

  // Helper: mark an item Released and track it on the main branch
  async function releaseOnMain(item: Software) {
    await testDb.db
      .update(items)
      .set({ state: 'Released' })
      .where(eq(items.id, item.id!))
    const mainBranch = await BranchService.getMainBranch(designId)
    await testDb.db.insert(branchItems).values({
      branchId: mainBranch!.id,
      itemMasterId: item.masterId!,
      currentItemId: item.id!,
      baseItemId: item.id!,
      changeType: null,
    })
  }

  async function getSoftwareRow(itemId: string) {
    const [row] = await testDb.db
      .select()
      .from(software)
      .where(eq(software.itemId, itemId))
      .limit(1)
    return row
  }

  const file = (path: string, content: string) => ({
    path,
    data: Buffer.from(content, 'utf8'),
  })

  // ==========================================================================
  // Blob store
  // ==========================================================================

  describe('blob deduplication', () => {
    it('stores identical content once, across paths and imports', async () => {
      const sw = await createSoftware()

      const result1 = await SoftwareSourceService.importFiles(
        sw.id!,
        [
          file('src/a.c', 'int shared() { return 1; }\n'),
          file('src/b.c', 'int shared() { return 1; }\n'), // same content
          file('src/c.c', 'int unique() { return 2; }\n'),
        ],
        user.id,
      )

      // Two distinct contents -> two blobs, three manifest entries
      expect(result1.blobsCreated).toBe(2)
      expect(result1.manifest.fileCount).toBe(3)

      const entries = result1.manifest.entries
      expect(entries.find((e) => e.path === 'src/a.c')!.hash).toBe(
        entries.find((e) => e.path === 'src/b.c')!.hash,
      )

      // Re-importing already-stored content creates no new blobs
      const result2 = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('src/d.c', 'int shared() { return 1; }\n')],
        user.id,
      )
      expect(result2.blobsCreated).toBe(0)
      expect(result2.manifest.fileCount).toBe(4)
    })

    it('storage is proportional to change when editing one file', async () => {
      const sw = await createSoftware()

      await SoftwareSourceService.importFiles(
        sw.id!,
        [
          file('main.c', 'int main() {}\n'),
          file('pid.c', 'float pid(float e) { return e; }\n'),
          file('config.h', '#define KP 1.0\n'),
        ],
        user.id,
      )

      const result = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('pid.c', 'float pid(float e) { return 2 * e; }\n')],
        user.id,
      )

      expect(result.blobsCreated).toBe(1)
      expect(result.manifest.fileCount).toBe(3)
    })
  })

  // ==========================================================================
  // Manifest immutability
  // ==========================================================================

  describe('manifest immutability', () => {
    it('editing creates a new manifest and leaves the old one untouched', async () => {
      const sw = await createSoftware()

      const r1 = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'v1\n')],
        user.id,
      )
      const m1 = r1.manifest

      const r2 = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'v2\n')],
        user.id,
      )

      expect(r2.manifest.id).not.toBe(m1.id)

      // The old manifest still exists, entries byte-for-byte identical
      const m1After = await SoftwareSourceService.getManifestById(m1.id)
      expect(m1After).not.toBeNull()
      expect(m1After!.entries).toEqual(m1.entries)

      // Old blob still present under its hash
      const oldHash = m1.entries[0]!.hash
      const [oldBlob] = await testDb.db
        .select()
        .from(softwareBlobs)
        .where(eq(softwareBlobs.hash, oldHash))
        .limit(1)
      expect(oldBlob).toBeDefined()
      expect(oldBlob!.content).toBe('v1\n')
    })

    it('replace mode produces a manifest with only the new files', async () => {
      const sw = await createSoftware()

      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('old.c', 'old\n'), file('keep.c', 'keep\n')],
        user.id,
      )

      const result = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('new.c', 'new\n')],
        user.id,
        { replace: true },
      )

      expect(result.manifest.fileCount).toBe(1)
      expect(result.manifest.entries[0]!.path).toBe('new.c')
    })
  })

  // ==========================================================================
  // Path validation (import cannot write outside the tree)
  // ==========================================================================

  describe('path validation', () => {
    it('rejects traversal, absolute, and malformed paths', async () => {
      const sw = await createSoftware()

      for (const bad of [
        '../evil.c',
        'src/../../evil.c',
        '/etc/passwd',
        'C:/windows/evil.c',
        'src//double.c',
        '',
      ]) {
        await expect(
          SoftwareSourceService.importFiles(sw.id!, [file(bad, 'x')], user.id),
        ).rejects.toThrow(ValidationError)
      }
    })

    it('rejects files above the size cap with a clear error', async () => {
      const sw = await createSoftware()
      const big = Buffer.alloc(1024 * 1024 + 1, 0x61)

      await expect(
        SoftwareSourceService.importFiles(
          sw.id!,
          [{ path: 'big.bin', data: big }],
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })
  })

  // ==========================================================================
  // Zip import
  // ==========================================================================

  describe('zip import', () => {
    it('expands a zip, strips the common root, and skips junk entries', async () => {
      const sw = await createSoftware()

      const zip = Buffer.from(
        zipSync({
          'firmware-1.0/src/main.c': strToU8('int main() {}\n'),
          'firmware-1.0/Makefile': strToU8('all:\n'),
          'firmware-1.0/.git/HEAD': strToU8('ref: refs/heads/main\n'),
          'firmware-1.0/.DS_Store': strToU8('junk'),
        }),
      )

      const result = await SoftwareSourceService.importZip(sw.id!, zip, user.id)

      const paths = result.manifest.entries.map((e) => e.path).sort()
      expect(paths).toEqual(['Makefile', 'src/main.c'])
    })
  })

  // ==========================================================================
  // Read path
  // ==========================================================================

  describe('reading trees and files', () => {
    it('returns tree and file content for an item', async () => {
      const sw = await createSoftware()
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('src/main.c', 'int main() { return 0; }\n')],
        user.id,
      )

      const { item, manifest } = await SoftwareSourceService.getTree(sw.id!)
      expect(manifest).not.toBeNull()
      expect(manifest!.fileCount).toBe(1)

      const content = await SoftwareSourceService.getFileContent(
        item.manifestId!,
        'src/main.c',
      )
      expect(content.encoding).toBe('utf8')
      expect(content.content).toBe('int main() { return 0; }\n')
      expect(content.isBinary).toBe(false)
    })

    it('diffs manifests as added/removed/modified path sets', async () => {
      const sw = await createSoftware()

      const r1 = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('keep.c', 'same\n'), file('edit.c', 'v1\n'), file('gone.c', 'x')],
        user.id,
      )
      const r2 = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('keep.c', 'same\n'), file('edit.c', 'v2\n'), file('new.c', 'y')],
        user.id,
        { replace: true },
      )

      const diff = await SoftwareSourceService.diffManifests(
        r1.manifest.id,
        r2.manifest.id,
      )

      expect(diff).toEqual([
        expect.objectContaining({ path: 'edit.c', status: 'modified' }),
        expect.objectContaining({ path: 'gone.c', status: 'removed' }),
        expect.objectContaining({ path: 'new.c', status: 'added' }),
      ])
    })
  })

  // ==========================================================================
  // Versioning: the manifest pointer rides the item version
  // ==========================================================================

  describe('version-pinned manifests across the ECO cycle', () => {
    it('checkout copies the manifest pointer; edits repoint only the working copy; merge releases it', async () => {
      // 1. Software item with source tree M1, Released on main
      const sw = await createSoftware()
      const r1 = await SoftwareSourceService.importFiles(
        sw.id!,
        [
          file('src/main.c', 'int main() {}\n'),
          file('src/pid.c', 'float pid() { return 0; }\n'),
        ],
        user.id,
      )
      const m1 = r1.manifest
      await releaseOnMain(sw)

      // 2. ECO revises it -> working copy on the ECO branch
      const eco = await createChangeOrder()
      await ChangeOrderService.addAffectedItem(
        eco.id,
        { affectedItemId: sw.id!, changeAction: 'revise' },
        user.id,
      )

      const [workingCopy] = await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.masterId, sw.masterId!), like(items.revision, '-%')),
        )
        .limit(1)
      expect(workingCopy).toBeDefined()

      // Checkout pinned the manifest: working copy starts at M1
      const wcRowBefore = await getSoftwareRow(workingCopy!.id)
      expect(wcRowBefore?.manifestId).toBe(m1.id)

      // 3. Edit on the branch -> new manifest M2 on the working copy only
      const r2 = await SoftwareSourceService.importFiles(
        workingCopy!.id,
        [file('src/pid.c', 'float pid() { return 1; }\n')],
        user.id,
      )
      const m2 = r2.manifest
      expect(m2.id).not.toBe(m1.id)

      const wcRowAfter = await getSoftwareRow(workingCopy!.id)
      expect(wcRowAfter?.manifestId).toBe(m2.id)

      // Rev A on main is untouched - still pinned to M1
      const revARow = await getSoftwareRow(sw.id!)
      expect(revARow?.manifestId).toBe(m1.id)

      // 4. Merge the ECO branch -> revision B released with M2
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )
      const mergeResult = await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )
      expect(mergeResult.revisionsAssigned[sw.itemNumber!]).toBe('B')

      // The released current version carries M2...
      const [released] = await testDb.db
        .select()
        .from(items)
        .where(and(eq(items.masterId, sw.masterId!), eq(items.isCurrent, true)))
        .limit(1)
      expect(released).toBeDefined()
      expect(released!.revision).toBe('B')
      expect(released!.state).toBe('Released')

      const releasedRow = await getSoftwareRow(released!.id)
      expect(releasedRow?.manifestId).toBe(m2.id)

      // ...and Rev A still resolves to M1 (time travel intact)
      const revAAfterMerge = await getSoftwareRow(sw.id!)
      expect(revAAfterMerge?.manifestId).toBe(m1.id)

      // Both manifests still exist and are unchanged
      const m1Final = await SoftwareSourceService.getManifestById(m1.id)
      const m2Final = await SoftwareSourceService.getManifestById(m2.id)
      expect(m1Final!.entries).toEqual(m1.entries)
      expect(m2Final!.entries).toEqual(m2.entries)
    })

    it('a software item added on an ECO branch keeps its extension data through release', async () => {
      const eco = await createChangeOrder()
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )

      // New software item with placeholder revision (added on the branch)
      const sw = await ItemService.create<Software>(
        'Software',
        {
          itemNumber: `SW-${uniquePrefix}-added`,
          revision: '-',
          name: 'Branch-added Firmware',
          designId,
          state: 'Draft',
          itemType: 'Software',
          softwareType: 'firmware',
          sourceMode: 'internal',
          targetHardware: 'STM32F407',
        },
        user.id,
      )
      const r = await SoftwareSourceService.importFiles(
        sw.id!,
        [file('boot.c', 'void boot() {}\n')],
        user.id,
      )

      await testDb.db.insert(branchItems).values({
        branchId: branch.id,
        itemMasterId: sw.masterId!,
        currentItemId: sw.id!,
        baseItemId: null,
        changeType: 'added',
      })

      const mergeResult = await ChangeOrderMergeService.mergeBranchToMain(
        branch.id,
        eco.id,
        user.id,
      )
      expect(mergeResult.itemsAdded).toBe(1)
      expect(mergeResult.revisionsAssigned[sw.itemNumber!]).toBe('A')

      // The released version is a NEW items row - its extension row must
      // have been copied, manifest pointer included
      const [released] = await testDb.db
        .select()
        .from(items)
        .where(and(eq(items.masterId, sw.masterId!), eq(items.isCurrent, true)))
        .limit(1)
      expect(released).toBeDefined()
      expect(released!.id).not.toBe(sw.id)

      const releasedRow = await getSoftwareRow(released!.id)
      expect(releasedRow).toBeDefined()
      expect(releasedRow!.manifestId).toBe(r.manifest.id)
      expect(releasedRow!.targetHardware).toBe('STM32F407')
      expect(releasedRow!.softwareType).toBe('firmware')
    })
  })

  // ==========================================================================
  // Guard rails
  // ==========================================================================

  describe('mode guards', () => {
    it('refuses source import into external-mode items', async () => {
      const sw = await ItemService.create<Software>(
        'Software',
        {
          itemNumber: `SW-${uniquePrefix}-ext`,
          revision: 'A',
          name: 'External FW',
          designId,
          state: 'Draft',
          itemType: 'Software',
          sourceMode: 'external',
        },
        user.id,
      )

      await expect(
        SoftwareSourceService.importFiles(
          sw.id!,
          [file('main.c', 'x')],
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })
  })

  // ==========================================================================
  // Phase 2: draft editing (edit -> commit) and source field-change history
  // ==========================================================================

  describe('draft editing', () => {
    async function countCommits(branchId: string) {
      const rows = await testDb.db
        .select({ id: commits.id })
        .from(commits)
        .where(eq(commits.branchId, branchId))
      return rows.length
    }

    it('draft saves accumulate without commits; commitDraft promotes with per-file source history', async () => {
      const sw = await createSoftware()
      const r1 = await SoftwareSourceService.importFiles(
        sw.id!,
        [
          file('src/main.c', 'int main() {}\n'),
          file('src/pid.c', 'float pid() { return 0; }\n'),
        ],
        user.id,
      )
      const m1 = r1.manifest

      const mainBranch = await BranchService.getMainBranch(designId)
      const commitsBefore = await countCommits(mainBranch!.id)

      // Two draft saves - no commits, committed manifest untouched
      await SoftwareSourceService.saveFileToDraft(
        sw.id!,
        'src/pid.c',
        Buffer.from('float pid() { return 1; }\n'),
        user.id,
      )
      const d2 = await SoftwareSourceService.saveFileToDraft(
        sw.id!,
        'src/util.c',
        Buffer.from('int util() { return 2; }\n'),
        user.id,
      )

      expect(await countCommits(mainBranch!.id)).toBe(commitsBefore)
      const rowMid = await getSoftwareRow(sw.id!)
      expect(rowMid!.manifestId).toBe(m1.id)
      expect(rowMid!.draftManifestId).toBe(d2.manifest.id)
      // Draft builds on draft: second save sees the first save's edit
      expect(d2.manifest.fileCount).toBe(3)

      // Commit with a message
      const { item: committed } = await SoftwareSourceService.commitDraft(
        sw.id!,
        'Clamp integrator on saturation',
        user.id,
      )
      expect(committed.manifestId).toBe(d2.manifest.id)
      expect(committed.draftManifestId ?? null).toBeNull()
      expect(await countCommits(mainBranch!.id)).toBe(commitsBefore + 1)

      // The commit carries per-file source rows, not an opaque manifestId row
      const [commit] = await testDb.db
        .select()
        .from(commits)
        .where(
          and(
            eq(commits.branchId, mainBranch!.id),
            eq(commits.message, 'Clamp integrator on saturation'),
          ),
        )
        .limit(1)
      expect(commit).toBeDefined()

      const versions = await testDb.db
        .select()
        .from(itemVersions)
        .where(eq(itemVersions.commitId, commit!.id))
      expect(versions).toHaveLength(1)

      const changes = await testDb.db
        .select()
        .from(itemFieldChanges)
        .where(eq(itemFieldChanges.itemVersionId, versions[0]!.id))

      const sourceRows = changes.filter((c) => c.fieldCategory === 'source')
      expect(
        sourceRows.map((c) => `${c.fieldName}:${c.fieldPath}`).sort(),
      ).toEqual(['added:src/util.c', 'modified:src/pid.c'])

      const modified = sourceRows.find((c) => c.fieldPath === 'src/pid.c')!
      const oldEntry = m1.entries.find((e) => e.path === 'src/pid.c')!
      const newEntry = d2.manifest.entries.find((e) => e.path === 'src/pid.c')!
      expect(modified.oldValue).toEqual({
        hash: oldEntry.hash,
        size: oldEntry.size,
      })
      expect(modified.newValue).toEqual({
        hash: newEntry.hash,
        size: newEntry.size,
      })

      expect(changes.some((c) => c.fieldName === 'manifestId')).toBe(false)
      expect(changes.some((c) => c.fieldName === 'draftManifestId')).toBe(false)
    })

    it('delete and rename operate on the draft tree', async () => {
      const sw = await createSoftware()
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('a.c', 'a\n'), file('b.c', 'b\n')],
        user.id,
      )

      await SoftwareSourceService.renameFileInDraft(
        sw.id!,
        'a.c',
        'src/a.c',
        user.id,
      )
      const afterDelete = await SoftwareSourceService.deleteFileFromDraft(
        sw.id!,
        'b.c',
        user.id,
      )

      const paths = afterDelete.manifest.entries.map((e) => e.path)
      expect(paths).toEqual(['src/a.c'])

      // Committed tree untouched until commit
      const row = await getSoftwareRow(sw.id!)
      const committedManifest = await SoftwareSourceService.getManifestById(
        row!.manifestId!,
      )
      expect(committedManifest!.entries.map((e) => e.path).sort()).toEqual([
        'a.c',
        'b.c',
      ])
    })

    it('discardDraft reverts to the committed tree', async () => {
      const sw = await createSoftware()
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'v1\n')],
        user.id,
      )
      await SoftwareSourceService.saveFileToDraft(
        sw.id!,
        'main.c',
        Buffer.from('v2\n'),
        user.id,
      )

      const item = await SoftwareSourceService.discardDraft(sw.id!, user.id)
      expect(item.draftManifestId ?? null).toBeNull()
    })

    it('commitDraft refuses without a draft; import refuses while a draft exists', async () => {
      const sw = await createSoftware()
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'v1\n')],
        user.id,
      )

      await expect(
        SoftwareSourceService.commitDraft(sw.id!, 'nothing to do', user.id),
      ).rejects.toThrow(ValidationError)

      await SoftwareSourceService.saveFileToDraft(
        sw.id!,
        'main.c',
        Buffer.from('v2\n'),
        user.id,
      )
      await expect(
        SoftwareSourceService.importFiles(
          sw.id!,
          [file('other.c', 'x\n')],
          user.id,
        ),
      ).rejects.toThrow(ValidationError)
    })
  })

  // ==========================================================================
  // Phase 2: checkout gating (security gate)
  // ==========================================================================

  describe('checkout gating', () => {
    it("another user's checkout blocks draft edits; the holder can edit", async () => {
      const sw = await createSoftware()
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'v1\n')],
        user.id,
      )
      await releaseOnMain(sw)

      const eco = await createChangeOrder()
      await ChangeOrderService.addAffectedItem(
        eco.id,
        { affectedItemId: sw.id!, changeAction: 'revise' },
        user.id,
      )
      const [workingCopy] = await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.masterId, sw.masterId!), like(items.revision, '-%')),
        )
        .limit(1)

      // Another user takes the checkout lock. They are enrolled in the program
      // too: the subject here is who holds the checkout, and an outsider would
      // be turned away by the design-access check before reaching it.
      const otherUser = await insertTestUser(testDb.db)
      await testDb.db.insert(programMembers).values({
        programId,
        userId: otherUser.id,
        role: 'engineer',
        invitedBy: user.id,
      })
      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )
      await CheckoutService.checkout(
        { branchId: branch.id, itemMasterId: sw.masterId! },
        otherUser.id,
      )

      await expect(
        SoftwareSourceService.saveFileToDraft(
          workingCopy!.id,
          'main.c',
          Buffer.from('v2\n'),
          user.id,
        ),
      ).rejects.toThrow(ResourceLockedError)

      // The checkout holder can edit
      const saved = await SoftwareSourceService.saveFileToDraft(
        workingCopy!.id,
        'main.c',
        Buffer.from('v2\n'),
        otherUser.id,
      )
      expect(saved.manifest.fileCount).toBe(1)
    })

    it('a locked branch blocks draft edits', async () => {
      const sw = await createSoftware()
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'v1\n')],
        user.id,
      )
      await releaseOnMain(sw)

      const eco = await createChangeOrder()
      await ChangeOrderService.addAffectedItem(
        eco.id,
        { affectedItemId: sw.id!, changeAction: 'revise' },
        user.id,
      )
      const [workingCopy] = await testDb.db
        .select()
        .from(items)
        .where(
          and(eq(items.masterId, sw.masterId!), like(items.revision, '-%')),
        )
        .limit(1)

      const { branch } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco.id,
        user.id,
      )
      await testDb.db
        .update(branches)
        .set({ isLocked: true })
        .where(eq(branches.id, branch.id))

      await expect(
        SoftwareSourceService.saveFileToDraft(
          workingCopy!.id,
          'main.c',
          Buffer.from('v2\n'),
          user.id,
        ),
      ).rejects.toThrow(BranchProtectionError)
    })

    it('released items on protected main cannot be edited', async () => {
      const sw = await createSoftware()
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'v1\n')],
        user.id,
      )
      await releaseOnMain(sw) // design now has a Released item -> main protected

      await expect(
        SoftwareSourceService.saveFileToDraft(
          sw.id!,
          'main.c',
          Buffer.from('v2\n'),
          user.id,
        ),
      ).rejects.toThrow(BranchProtectionError)
    })
  })

  // ==========================================================================
  // Phase 2: per-file conflict sharpening (complex algorithm gate)
  // ==========================================================================

  describe('per-file conflict sharpening', () => {
    // Build three manifests (base / ours / theirs) via replace imports on a
    // scratch item, then exercise refineSourceConflicts directly.
    async function buildManifests() {
      const scratch = await createSoftware('scratch')
      const base = (
        await SoftwareSourceService.importFiles(
          scratch.id!,
          [file('a.c', 'a v1\n'), file('b.c', 'b v1\n')],
          user.id,
          { replace: true },
        )
      ).manifest
      const oursAC = (
        await SoftwareSourceService.importFiles(
          scratch.id!,
          [file('a.c', 'a v2-ours\n'), file('b.c', 'b v1\n')],
          user.id,
          { replace: true },
        )
      ).manifest
      const theirsBC = (
        await SoftwareSourceService.importFiles(
          scratch.id!,
          [file('a.c', 'a v1\n'), file('b.c', 'b v2-theirs\n')],
          user.id,
          { replace: true },
        )
      ).manifest
      const theirsAC = (
        await SoftwareSourceService.importFiles(
          scratch.id!,
          [file('a.c', 'a v2-theirs\n'), file('b.c', 'b v1\n')],
          user.id,
          { replace: true },
        )
      ).manifest
      return { base, oursAC, theirsBC, theirsAC }
    }

    const swRecord = (manifestId: string | null) => ({
      itemType: 'Software',
      manifestId,
    })

    const manifestConflict = (base: string, ours: string, theirs: string) => [
      {
        fieldName: 'manifestId',
        baseValue: base,
        ourValue: ours,
        theirValue: theirs,
      },
    ]

    it('drops the manifest conflict when branches touched disjoint files', async () => {
      const { base, oursAC, theirsBC } = await buildManifests()

      const refined = await ConflictDetectionService.refineSourceConflicts(
        swRecord(base.id),
        swRecord(oursAC.id),
        swRecord(theirsBC.id),
        manifestConflict(base.id, oursAC.id, theirsBC.id),
      )

      expect(refined).toEqual([])
    })

    it('emits one per-file conflict when the same file changed differently', async () => {
      const { base, oursAC, theirsAC } = await buildManifests()

      const refined = await ConflictDetectionService.refineSourceConflicts(
        swRecord(base.id),
        swRecord(oursAC.id),
        swRecord(theirsAC.id),
        manifestConflict(base.id, oursAC.id, theirsAC.id),
      )

      expect(refined).toHaveLength(1)
      expect(refined[0]).toMatchObject({
        fieldName: 'source',
        fieldPath: 'a.c',
      })
    })

    it('does not conflict when both sides made the identical change', async () => {
      const { base, oursAC } = await buildManifests()

      const refined = await ConflictDetectionService.refineSourceConflicts(
        swRecord(base.id),
        swRecord(oursAC.id),
        swRecord(oursAC.id),
        manifestConflict(base.id, oursAC.id, oursAC.id),
      )

      expect(refined).toEqual([])
    })

    it('cross-ECO detection reports file-level conflicts through the real flow', async () => {
      // Released software with two files, revised by two concurrent ECOs
      const sw = await createSoftware('xeco')
      await SoftwareSourceService.importFiles(
        sw.id!,
        [file('main.c', 'int main() {}\n'), file('pid.c', 'v1\n')],
        user.id,
      )
      await releaseOnMain(sw)

      const eco1 = await createChangeOrder()
      await ChangeOrderService.addAffectedItem(
        eco1.id,
        { affectedItemId: sw.id!, changeAction: 'revise' },
        user.id,
      )
      const eco2 = await createChangeOrder()
      await ChangeOrderService.addAffectedItem(
        eco2.id,
        { affectedItemId: sw.id!, changeAction: 'revise' },
        user.id,
      )

      const { branch: branch1 } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco1.id,
        user.id,
      )
      const { branch: branch2 } = await BranchService.getOrCreateEcoBranch(
        designId,
        eco2.id,
        user.id,
      )

      const wcOn = async (branchId: string) => {
        const [bi] = await testDb.db
          .select()
          .from(branchItems)
          .where(
            and(
              eq(branchItems.branchId, branchId),
              eq(branchItems.itemMasterId, sw.masterId!),
            ),
          )
          .limit(1)
        return bi!.currentItemId!
      }

      const wc1 = await wcOn(branch1.id)
      const wc2 = await wcOn(branch2.id)

      // ECO1 edits pid.c; ECO2 edits main.c (disjoint) -> warning only
      await SoftwareSourceService.saveFileToDraft(
        wc1,
        'pid.c',
        Buffer.from('v2-eco1\n'),
        user.id,
      )
      await SoftwareSourceService.commitDraft(wc1, 'eco1 pid fix', user.id)

      await SoftwareSourceService.saveFileToDraft(
        wc2,
        'main.c',
        Buffer.from('int main() { return 1; }\n'),
        user.id,
      )
      await SoftwareSourceService.commitDraft(wc2, 'eco2 main fix', user.id)

      const disjoint = await ConflictDetectionService.detectConflictsForEco(
        eco1.id,
      )
      const swConflicts = disjoint.conflicts.filter(
        (c) => c.itemMasterId === sw.masterId,
      )
      expect(swConflicts.some((c) => c.conflictType === 'field_conflict')).toBe(
        false,
      )
      expect(swConflicts.some((c) => c.conflictType === 'cross_eco')).toBe(true)

      // ECO2 now also edits pid.c differently -> real per-file conflict
      await SoftwareSourceService.saveFileToDraft(
        wc2,
        'pid.c',
        Buffer.from('v2-eco2\n'),
        user.id,
      )
      await SoftwareSourceService.commitDraft(wc2, 'eco2 pid tweak', user.id)

      const overlapping = await ConflictDetectionService.detectConflictsForEco(
        eco1.id,
      )
      const fileConflict = overlapping.conflicts.find(
        (c) =>
          c.itemMasterId === sw.masterId && c.conflictType === 'field_conflict',
      )
      expect(fileConflict).toBeDefined()
      expect(fileConflict!.fieldConflicts).toEqual([
        expect.objectContaining({ fieldName: 'source', fieldPath: 'pid.c' }),
      ])
    })
  })
})
