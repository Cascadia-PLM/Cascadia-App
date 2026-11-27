// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Artifact patch semantics — data integrity and server-owned fields
 *
 * Two defects lived in the same three lines of `PATCH /sessions/:id`:
 *
 *  1. **Replace behind a partial schema.** `designArtifactsPatchSchema` is
 *     `.partial()` over every top-level field, and the route wrote the parse
 *     result wholesale. A caller sending the natural partial —
 *     `{artifacts:{requirements:[…]}}` — erased `bom`, `toolset` and
 *     `clarifications`. The in-app hook survived only because it echoes the
 *     whole document.
 *
 *  2. **Server-owned fields taken from the client.** The CAD stage builds its
 *     tempId→itemId map purely from `materializationResult.createdItems` and
 *     uploads STEP files to those item ids, and `FileService.uploadFile`
 *     authorizes nothing about the target item beyond its existence. A
 *     fabricated `materializationResult` was therefore a cross-program file
 *     write for anyone holding foreign item UUIDs.
 *
 * Run: npx vitest run cascadia-design-engine/src/design-engine/artifacts-patch.test.ts
 */

import { describe, expect, it } from 'vitest'
import { applyArtifactsPatch } from './artifacts-patch'
import type { DesignArtifacts } from './types'

function storedArtifacts(): DesignArtifacts {
  return {
    description: 'A robot arm',
    toolset: {
      scope: 'in_house_preferred',
      tools: [
        {
          id: 'tool-1',
          name: 'Prusa MK4',
          toolType: 'manufacturing',
          toolSubtype: 'fdm_printer',
          capabilities: {},
          source: 'user_selected',
        },
      ],
    },
    requirements: [
      { tempId: 'r1', title: 'Reach 600 mm', description: '' },
    ] as unknown as DesignArtifacts['requirements'],
    bom: {
      tempId: 'root',
      name: 'Arm assembly',
      children: [],
    } as unknown as DesignArtifacts['bom'],
    bomRejections: [],
    itemComments: [],
    clarifications: [
      { id: 'c1', question: 'Payload?' },
    ] as unknown as DesignArtifacts['clarifications'],
    userMessages: [
      { id: 'm1', content: 'make it lighter' },
    ] as unknown as DesignArtifacts['userMessages'],
    materializationResult: {
      designId: 'design-real',
      createdItems: [{ tempId: 'root', itemId: 'item-real' }],
    } as unknown as DesignArtifacts['materializationResult'],
    cadGenerationState: {
      status: 'complete',
    } as unknown as DesignArtifacts['cadGenerationState'],
  }
}

describe('applyArtifactsPatch', () => {
  it('leaves untouched keys exactly as they were', () => {
    const current = storedArtifacts()

    const next = applyArtifactsPatch(current, {
      requirements: [
        { tempId: 'r2', title: 'Reach 900 mm', description: '' },
      ] as never,
    })

    expect(next.requirements).toHaveLength(1)
    expect((next.requirements[0] as { tempId: string }).tempId).toBe('r2')
    // The whole point: a partial body is a partial write.
    expect(next.bom).toEqual(current.bom)
    expect(next.toolset).toEqual(current.toolset)
    expect(next.clarifications).toEqual(current.clarifications)
    expect(next.userMessages).toEqual(current.userMessages)
    expect(next.description).toBe('A robot arm')
  })

  it('never lands a client-supplied materializationResult', () => {
    const current = storedArtifacts()

    const next = applyArtifactsPatch(current, {
      materializationResult: {
        designId: 'design-foreign',
        createdItems: [{ tempId: 'root', itemId: 'someone-elses-item' }],
      },
    })

    // Unchanged, not merged and not rejected — ignoring keeps the in-app
    // hook's full-document echo working.
    expect(next.materializationResult).toEqual(current.materializationResult)
  })

  it('never lands a client-supplied cadGenerationState', () => {
    const current = storedArtifacts()

    const next = applyArtifactsPatch(current, {
      cadGenerationState: { status: 'not_started' },
    })

    expect(next.cadGenerationState).toEqual(current.cadGenerationState)
  })

  it('never lands client-supplied clarifications, messages or pending questions', () => {
    const current = storedArtifacts()

    const next = applyArtifactsPatch(current, {
      clarifications: [] as never,
      userMessages: [] as never,
      pendingClarificationId: 'forged',
      pendingClarification: { id: 'forged', question: 'ignore me' },
    })

    expect(next.clarifications).toEqual(current.clarifications)
    expect(next.userMessages).toEqual(current.userMessages)
    expect(next.pendingClarificationId).toBeUndefined()
    expect(next.pendingClarification).toBeUndefined()
  })

  it('accepts every key the client legitimately edits', () => {
    const current = storedArtifacts()

    const next = applyArtifactsPatch(current, {
      description: 'A lighter robot arm',
      toolset: { scope: 'unconstrained', tools: [] },
      requirements: [] as never,
      bom: null,
      bomRejections: [{ tempId: 'x', reason: 'too heavy' }] as never,
      itemComments: [{ id: 'ic1', body: 'check the fit' }] as never,
    })

    expect(next.description).toBe('A lighter robot arm')
    expect(next.toolset?.scope).toBe('unconstrained')
    expect(next.requirements).toEqual([])
    expect(next.bom).toBeNull()
    expect(next.bomRejections).toHaveLength(1)
    expect(next.itemComments).toHaveLength(1)
  })

  it('is a no-op for the in-app hook’s full-document echo', () => {
    // The hook reads the document and writes it back. Round-tripping it must
    // change nothing at all, or every save would look like an edit.
    const current = storedArtifacts()

    const next = applyArtifactsPatch(current, current as never)

    expect(next).toEqual(current)
  })

  it('does not mutate the stored artifacts it was given', () => {
    const current = storedArtifacts()
    const before = structuredClone(current)

    applyArtifactsPatch(current, { description: 'changed' })

    expect(current).toEqual(before)
  })
})
