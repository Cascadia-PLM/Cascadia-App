import { describe, expect, it } from 'vitest'
import { createBomTools, createConsolidationTools } from './bom-tools'
import { createRequirementsTools } from './requirements-tools'
import { createToolsetTools } from './toolset-tools'
import type { ToolContext } from '@/lib/ai/tools/permission-wrapper'

/**
 * Anthropic requires tool `input_schema` to be valid JSON Schema draft 2020-12,
 * where `items` must be a single schema. `@tanstack/ai` serializes Zod with
 * `target: 'draft-07'`, whose tuple form emits `items: [...]` (an array) plus
 * `additionalItems`. A tool carrying either makes the whole request 400 — and
 * the adapter reports that as an `error` chunk, not a throw, so the stage looks
 * like a model that said nothing. Keep every tool schema free of both.
 */
const noop: any = () => {}
const context = { userId: 'u', programId: 'p' } as unknown as ToolContext

function toJsonSchema(inputSchema: any): unknown {
  return inputSchema['~standard'].jsonSchema.input({ target: 'draft-07' })
}

function draft2020Violations(node: unknown, path = 'root'): Array<string> {
  if (typeof node !== 'object' || node === null) return []
  const found: Array<string> = []
  const record = node as Record<string, unknown>

  if (Array.isArray(record.items)) found.push(`${path}.items is an array`)
  if (record.additionalItems !== undefined) {
    found.push(`${path}.additionalItems is set`)
  }
  for (const [key, value] of Object.entries(record)) {
    found.push(...draft2020Violations(value, `${path}.${key}`))
  }
  return found
}

const toolGroups: Array<[string, Array<any>]> = [
  [
    'bom',
    createBomTools(
      context,
      {
        nodes: new Map(),
        proposedParts: [],
        rootTempId: null,
        changeVersion: 0,
      },
      noop,
      noop,
    ),
  ],
  [
    'consolidation',
    createConsolidationTools(
      {
        nodes: new Map(),
        proposedParts: [],
        rootTempId: null,
        changeVersion: 0,
      },
      noop,
      noop,
    ),
  ],
  ['requirements', createRequirementsTools(context, noop, noop)],
  ['toolset', Object.values(createToolsetTools('p', noop, noop))],
]

describe('LLM tool schemas', () => {
  const cases = toolGroups.flatMap(([group, tools]) =>
    tools
      .filter((tool) => tool?.inputSchema?.['~standard'])
      .map((tool) => ({ group, name: tool.name, tool })),
  )

  it('covers every tool group', () => {
    expect(cases.length).toBeGreaterThan(15)
  })

  it.each(cases)(
    '$group/$name serializes to valid draft 2020-12',
    ({ tool }) => {
      expect(draft2020Violations(toJsonSchema(tool.inputSchema))).toEqual([])
    },
  )
})
