// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * The dev MCP server's docs tools resolve paths against REPO_ROOT, and a
 * REPO_ROOT that points at the wrong directory fails silently: `search_docs`
 * simply returns zero matches. That is how the `packages/core` move broke
 * both tools without anything going red. These tests pin the two halves —
 * that REPO_ROOT is the checkout, and that the traversal guard built on it
 * still refuses to read outside the doc tree.
 *
 * Run: npx vitest run packages/core/src/lib/mcp/dev-tools.test.ts
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDevToolSpecs } from './dev-tools'
import { REPO_ROOT } from './repo-root'
import type { McpToolSpec } from './server-factory'

function tool(name: string): McpToolSpec {
  const spec = createDevToolSpecs().find((t) => t.name === name)
  if (!spec) throw new Error(`No such dev tool: ${name}`)
  return spec
}

/** Run a tool the way the server factory does — parse, then execute. */
async function call(name: string, args: unknown = {}): Promise<unknown> {
  const spec = tool(name)
  return spec.execute(spec.inputSchema.parse(args))
}

describe('dev MCP tools — repository root', () => {
  it('resolves REPO_ROOT to the workspace root, not a package', () => {
    const manifest: unknown = JSON.parse(
      readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'),
    )
    expect(manifest).toHaveProperty('workspaces')
    expect(path.basename(REPO_ROOT)).not.toBe('core')
  })

  it('finds the docs tree under REPO_ROOT', async () => {
    const result = (await call('search_docs', {
      query: 'cascadia',
    })) as { matches: Array<{ path: string }>; filesSearched: number }

    expect(result.filesSearched).toBeGreaterThan(0)
    expect(result.matches.length).toBeGreaterThan(0)
  })

  it('reads a doc by repo-relative path', async () => {
    const result = (await call('read_doc', {
      path: 'docs/features/mcp.md',
    })) as { path: string; content: string }

    expect(result.content).toContain('cascadia-dev')
  })
})

describe('dev MCP tools — doc path guard', () => {
  it.each([
    '../CLAUDE.md',
    'docs/../../CLAUDE.md',
    String.raw`..\FreeCADSampleData\CLAUDE.md`,
    'packages/core/package.json',
    'docs/features/mcp.txt',
  ])('refuses %s', async (bad) => {
    await expect(call('read_doc', { path: bad })).rejects.toThrow()
  })
})
