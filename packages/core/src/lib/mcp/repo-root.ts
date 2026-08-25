// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Repository root for the dev/admin MCP server.
 *
 * The dev server reads `docs/`, the root markdown files, and runs the root
 * `package.json` scripts — all of which live at the top of the checkout, not
 * inside `packages/core`. Counting `..` segments from this file's location
 * encoded the pre-monorepo layout and silently pointed at `packages/core`
 * after the move: `search_docs` found zero files, `read_doc` returned ENOENT,
 * and the `db_*` commands would have run in the wrong directory.
 *
 * Walk up to the manifest that declares `workspaces` instead. That is the one
 * marker that identifies the workspace root by what it *is* rather than by how
 * deep this file happens to sit, so it survives the next move.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function findRepoRoot(from: string): string {
  let dir = from
  for (;;) {
    try {
      const manifest: unknown = JSON.parse(
        readFileSync(path.join(dir, 'package.json'), 'utf8'),
      )
      if (
        typeof manifest === 'object' &&
        manifest !== null &&
        'workspaces' in manifest
      ) {
        return dir
      }
    } catch {
      // No readable manifest at this level — keep walking up.
    }
    const parent = path.dirname(dir)
    if (parent === dir) {
      // Fail loudly. A wrong-but-plausible root is what caused this bug.
      throw new Error(
        `Cascadia repository root not found: walked up from ${from} without ` +
          'finding a package.json that declares "workspaces". The dev MCP ' +
          'server must be run from a repository checkout.',
      )
    }
    dir = parent
  }
}

/** Absolute path to the workspace root of this checkout. */
export const REPO_ROOT = findRepoRoot(
  path.dirname(fileURLToPath(import.meta.url)),
)
