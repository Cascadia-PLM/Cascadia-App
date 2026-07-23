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
import { SoftwareSourceService } from './SoftwareSourceService'
import { BranchService } from './BranchService'
import { DesignService } from './DesignService'
import type { TestUser } from '@/__tests__/fixtures/users'
import type { Software } from '@/lib/items/types/software'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import {
  branchItems,
  items,
  programs,
  software,
  softwareBlobs,
  workflowDefinitions,
  workflowInstances,
} from '@/lib/db/schema'
import { ItemTypeRegistry } from '@/lib/items/registry'
import { seedStandardPartLifecycle } from '@/__tests__/fixtures/lifecycles'
import { takeFirst } from '@/lib/db/take-first'
import { ValidationError } from '@/lib/errors'

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
          SoftwareSourceService.importFiles(
            sw.id!,
            [file(bad, 'x')],
            user.id,
          ),
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

      const result = await SoftwareSourceService.importZip(
        sw.id!,
        zip,
        user.id,
      )

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
        .where(
          and(eq(items.masterId, sw.masterId!), eq(items.isCurrent, true)),
        )
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
        .where(
          and(eq(items.masterId, sw.masterId!), eq(items.isCurrent, true)),
        )
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
})
