// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

/**
 * SoftwareSourceService - content-addressed source storage for Software items.
 *
 * Internal-mode Software items store their source tree in Cascadia as
 * deduplicated blobs (software_blobs, keyed by SHA-256) referenced from
 * immutable tree snapshots (software_manifests). The software extension row
 * points at the manifest for that item VERSION, so branch isolation, time
 * travel, and release semantics ride the items master/instance pattern -
 * repointing the manifest is an ordinary field update through ItemService,
 * which enforces branch protection and records the field change.
 *
 * Immutability invariants (mirroring commits/itemVersions):
 * - blobs are never mutated: same content = same hash = same row
 * - manifests are never mutated: any tree change creates a new manifest
 *
 * See docs/proposals/software-management.md.
 */

import { createHash } from 'node:crypto'
import { eq, inArray } from 'drizzle-orm'
import { unzipSync } from 'fflate'
import { db } from '../db'
import { softwareBlobs, softwareManifests } from '../db/schema'
import { NotFoundError, ValidationError } from '../errors'
import { ItemService } from '../items/services/ItemService'
import { VersionResolver } from './VersionResolver'
import type { TransactionClient } from '../db'
import type {
  SoftwareManifest,
  SoftwareManifestEntry,
} from '../db/schema/software'
import type { Software } from '../items/types/software'
import type { VersionContext } from './VersionResolver'
import { takeFirst } from '@/lib/db/take-first'

// Size guardrails (proposal §3.2): firmware-scale trees, not monorepos.
const MAX_FILE_SIZE = 1024 * 1024 // 1 MB per file
const MAX_MANIFEST_FILES = 2000
const MAX_PATH_LENGTH = 500

/** Zip/import entries matching these prefixes/names are silently skipped. */
const IGNORED_PATH_SEGMENTS = new Set(['.git', '__MACOSX', 'node_modules'])
const IGNORED_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db'])

export interface SourceFileInput {
  path: string
  data: Buffer
}

export interface SourceFileContent {
  path: string
  hash: string
  size: number
  isBinary: boolean
  /** UTF-8 text for text files, base64 for binary files */
  content: string
  encoding: 'utf8' | 'base64'
}

export interface ManifestDiffEntry {
  path: string
  status: 'added' | 'removed' | 'modified'
  oldHash?: string
  newHash?: string
  oldSize?: number
  newSize?: number
}

export interface ImportResult {
  item: Software
  manifest: SoftwareManifest
  filesImported: number
  blobsCreated: number
}

export class SoftwareSourceService {
  // ==========================================================================
  // Write path
  // ==========================================================================

  /**
   * Import files into a Software item's source tree.
   *
   * Creates blobs + a new immutable manifest, then repoints the item's
   * manifestId through ItemService.update() - so branch protection, checkout
   * rules, and field-change history all apply exactly as they do for any
   * other item field.
   *
   * @param options.replace - true: the manifest contains only these files;
   *   false (default): merge into the item's current tree (upsert by path)
   */
  static async importFiles(
    itemId: string,
    files: Array<SourceFileInput>,
    userId: string,
    options?: { replace?: boolean },
  ): Promise<ImportResult> {
    const item = await ItemService.findById(itemId)
    if (!item) {
      throw new NotFoundError('Software', itemId, { operation: 'importFiles' })
    }
    if (item.itemType !== 'Software') {
      throw new ValidationError(
        `Item ${itemId} is not a Software item (got ${item.itemType})`,
      )
    }
    const softwareItem = item as unknown as Software
    if ((softwareItem.sourceMode ?? 'internal') !== 'internal') {
      throw new ValidationError(
        'Source files can only be imported into internal-mode Software items',
      )
    }

    if (files.length === 0) {
      throw new ValidationError('No files to import')
    }

    // Validate and normalize paths up front
    const normalized = files.map((f) => ({
      path: this.normalizePath(f.path),
      data: f.data,
    }))
    for (const f of normalized) {
      if (f.data.length > MAX_FILE_SIZE) {
        throw new ValidationError(
          `File "${f.path}" exceeds the ${MAX_FILE_SIZE / 1024 / 1024} MB source file limit. ` +
            'Attach large/binary files (build artifacts) to the item as vault files instead.',
        )
      }
    }
    const seen = new Set<string>()
    for (const f of normalized) {
      if (seen.has(f.path)) {
        throw new ValidationError(`Duplicate path in import: "${f.path}"`)
      }
      seen.add(f.path)
    }

    // Base entries: existing tree unless replacing
    let baseEntries: Array<SoftwareManifestEntry> = []
    if (!options?.replace && softwareItem.manifestId) {
      const current = await this.getManifestById(softwareItem.manifestId)
      if (current) baseEntries = current.entries
    }

    const { manifest, blobsCreated } = await db.transaction(async (tx) => {
      const created = await this.storeBlobs(normalized, tx)

      const merged = new Map<string, SoftwareManifestEntry>(
        baseEntries.map((e) => [e.path, e]),
      )
      for (const f of normalized) {
        merged.set(f.path, {
          path: f.path,
          hash: sha256(f.data),
          size: f.data.length,
        })
      }

      if (merged.size > MAX_MANIFEST_FILES) {
        throw new ValidationError(
          `Source tree would contain ${merged.size} files, exceeding the ${MAX_MANIFEST_FILES}-file limit`,
        )
      }

      const newManifest = await this.createManifest(
        Array.from(merged.values()),
        userId,
        tx,
      )
      return { manifest: newManifest, blobsCreated: created }
    })

    // Repoint the item at the new snapshot through the standard update path
    // (enforces branch protection / checkout rules, records the field change)
    const updated = await ItemService.update<Software>(
      itemId,
      { manifestId: manifest.id },
      userId,
    )

    return {
      item: updated,
      manifest,
      filesImported: normalized.length,
      blobsCreated,
    }
  }

  /**
   * Import a zip archive into a Software item's source tree.
   * Strips a shared top-level directory (the "zip of a folder" case) and
   * skips VCS/OS junk entries.
   */
  static async importZip(
    itemId: string,
    zipData: Buffer,
    userId: string,
    options?: { replace?: boolean },
  ): Promise<ImportResult> {
    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(zipData))
    } catch {
      throw new ValidationError('Could not read zip archive')
    }

    let files: Array<SourceFileInput> = []
    for (const [rawPath, data] of Object.entries(entries)) {
      if (rawPath.endsWith('/')) continue // directory entry
      const path = rawPath.replace(/\\/g, '/')
      const segments = path.split('/')
      if (segments.some((s) => IGNORED_PATH_SEGMENTS.has(s))) continue
      const fileName = segments[segments.length - 1]
      if (!fileName || IGNORED_FILE_NAMES.has(fileName)) continue
      files.push({ path, data: Buffer.from(data) })
    }

    if (files.length === 0) {
      throw new ValidationError('Zip archive contains no importable files')
    }

    files = this.stripCommonRoot(files)
    return this.importFiles(itemId, files, userId, options)
  }

  // ==========================================================================
  // Read path
  // ==========================================================================

  static async getManifestById(
    manifestId: string,
  ): Promise<SoftwareManifest | null> {
    const [manifest] = await db
      .select()
      .from(softwareManifests)
      .where(eq(softwareManifests.id, manifestId))
      .limit(1)
    return manifest ?? null
  }

  /**
   * Get the source tree for a Software item, optionally resolved at a
   * version context (branch/commit/tag). Without a context, the given item
   * version's own manifest is returned.
   */
  static async getTree(
    itemId: string,
    context?: VersionContext,
  ): Promise<{
    item: Software
    manifest: SoftwareManifest | null
  }> {
    let item = await ItemService.findById(itemId)
    if (!item) {
      throw new NotFoundError('Software', itemId, { operation: 'getTree' })
    }
    if (item.itemType !== 'Software') {
      throw new ValidationError(
        `Item ${itemId} is not a Software item (got ${item.itemType})`,
      )
    }

    if (context && item.designId) {
      const resolved = await VersionResolver.getItemAtContext(
        item.masterId,
        item.designId,
        context,
      )
      if (!resolved) {
        throw new NotFoundError('Software', itemId, {
          operation: 'getTree',
          detail: 'Item does not exist at the requested version context',
        })
      }
      const resolvedFull = await ItemService.findById(resolved.id)
      if (!resolvedFull) {
        throw new NotFoundError('Software', resolved.id, {
          operation: 'getTree',
        })
      }
      item = resolvedFull
    }

    const softwareItem = item as unknown as Software
    const manifest = softwareItem.manifestId
      ? await this.getManifestById(softwareItem.manifestId)
      : null

    return { item: softwareItem, manifest }
  }

  /** Read one file's content from a manifest. */
  static async getFileContent(
    manifestId: string,
    path: string,
  ): Promise<SourceFileContent> {
    const manifest = await this.getManifestById(manifestId)
    if (!manifest) {
      throw new NotFoundError('SoftwareManifest', manifestId, {
        operation: 'getFileContent',
      })
    }

    const entry = manifest.entries.find((e) => e.path === path)
    if (!entry) {
      throw new NotFoundError('SourceFile', path, {
        operation: 'getFileContent',
      })
    }

    const [blob] = await db
      .select()
      .from(softwareBlobs)
      .where(eq(softwareBlobs.hash, entry.hash))
      .limit(1)
    if (!blob || blob.content === null) {
      throw new NotFoundError('SoftwareBlob', entry.hash, {
        operation: 'getFileContent',
      })
    }

    return {
      path: entry.path,
      hash: entry.hash,
      size: entry.size,
      isBinary: blob.isBinary,
      content: blob.content,
      encoding: blob.isBinary ? 'base64' : 'utf8',
    }
  }

  /**
   * Path-level diff between two manifests (either side may be null for
   * "empty tree"). Line-level diffs are computed client-side from the two
   * file contents.
   */
  static async diffManifests(
    fromManifestId: string | null,
    toManifestId: string | null,
  ): Promise<Array<ManifestDiffEntry>> {
    const fromEntries = fromManifestId
      ? ((await this.getManifestById(fromManifestId))?.entries ?? [])
      : []
    const toEntries = toManifestId
      ? ((await this.getManifestById(toManifestId))?.entries ?? [])
      : []

    const fromMap = new Map(fromEntries.map((e) => [e.path, e]))
    const toMap = new Map(toEntries.map((e) => [e.path, e]))

    const diff: Array<ManifestDiffEntry> = []
    for (const [path, from] of fromMap) {
      const to = toMap.get(path)
      if (!to) {
        diff.push({
          path,
          status: 'removed',
          oldHash: from.hash,
          oldSize: from.size,
        })
      } else if (to.hash !== from.hash) {
        diff.push({
          path,
          status: 'modified',
          oldHash: from.hash,
          newHash: to.hash,
          oldSize: from.size,
          newSize: to.size,
        })
      }
    }
    for (const [path, to] of toMap) {
      if (!fromMap.has(path)) {
        diff.push({
          path,
          status: 'added',
          newHash: to.hash,
          newSize: to.size,
        })
      }
    }

    return diff.sort((a, b) => a.path.localeCompare(b.path))
  }

  // ==========================================================================
  // Internals
  // ==========================================================================

  /**
   * Store blobs content-addressed; existing hashes are reused untouched.
   * Returns the number of newly created blob rows.
   */
  private static async storeBlobs(
    files: Array<SourceFileInput>,
    tx: TransactionClient,
  ): Promise<number> {
    // Deduplicate within the batch by hash
    const byHash = new Map<string, SourceFileInput>()
    for (const f of files) {
      byHash.set(sha256(f.data), f)
    }

    const hashes = Array.from(byHash.keys())
    const existing = await tx
      .select({ hash: softwareBlobs.hash })
      .from(softwareBlobs)
      .where(inArray(softwareBlobs.hash, hashes))
    const existingHashes = new Set(existing.map((r) => r.hash))

    const toInsert = hashes
      .filter((h) => !existingHashes.has(h))
      .map((hash) => {
        const file = byHash.get(hash)!
        const isBinary = isBinaryContent(file.data)
        return {
          hash,
          content: isBinary
            ? file.data.toString('base64')
            : file.data.toString('utf8'),
          size: file.data.length,
          isBinary,
        }
      })

    if (toInsert.length > 0) {
      // onConflictDoNothing guards against a concurrent import racing on the
      // same content - identical hash means identical content, so it is safe.
      await tx.insert(softwareBlobs).values(toInsert).onConflictDoNothing()
    }

    return toInsert.length
  }

  /** Create an immutable manifest snapshot from a set of entries. */
  private static async createManifest(
    entries: Array<SoftwareManifestEntry>,
    userId: string,
    tx: TransactionClient,
  ): Promise<SoftwareManifest> {
    const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
    return takeFirst(
      await tx
        .insert(softwareManifests)
        .values({
          entries: sorted,
          fileCount: sorted.length,
          totalSize: sorted.reduce((sum, e) => sum + e.size, 0),
          createdBy: userId,
        })
        .returning(),
      'software manifest',
    )
  }

  /** Normalize and validate a source path. Throws ValidationError on bad paths. */
  static normalizePath(rawPath: string): string {
    const path = rawPath.replace(/\\/g, '/').replace(/^\.\//, '')

    if (!path || path.length > MAX_PATH_LENGTH) {
      throw new ValidationError(`Invalid source path: "${rawPath}"`)
    }
    if (path.startsWith('/') || /^[a-zA-Z]:/.test(path)) {
      throw new ValidationError(`Source paths must be relative: "${rawPath}"`)
    }
    const segments = path.split('/')
    if (segments.some((s) => s === '' || s === '.' || s === '..')) {
      throw new ValidationError(`Invalid source path: "${rawPath}"`)
    }
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\x00-\x1f]/.test(path)) {
      throw new ValidationError(`Invalid source path: "${rawPath}"`)
    }
    return path
  }

  /**
   * If every file shares the same top-level directory (a zip of a folder),
   * strip it so the tree root is the project root.
   */
  private static stripCommonRoot(
    files: Array<SourceFileInput>,
  ): Array<SourceFileInput> {
    const roots = new Set(files.map((f) => f.path.split('/')[0]))
    if (roots.size !== 1) return files
    const root = roots.values().next().value
    // Only strip if it is actually a directory prefix (not a lone file)
    if (files.every((f) => f.path.startsWith(`${root}/`))) {
      return files.map((f) => ({
        path: f.path.slice(root!.length + 1),
        data: f.data,
      }))
    }
    return files
  }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

/** Heuristic binary detection: a NUL byte in the first 8 KB. */
function isBinaryContent(data: Buffer): boolean {
  const probe = data.subarray(0, 8192)
  return probe.includes(0)
}
