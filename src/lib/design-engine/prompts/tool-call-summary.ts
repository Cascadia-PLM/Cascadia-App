/**
 * Builds a markdown summary of prior tool calls from a session's llmHistory,
 * for injection into stage system prompts on resume so the LLM does not
 * redundantly re-run searches that already executed.
 */

import type { LlmHistoryEntry } from '../types'

interface ParsedToolEntry {
  toolName: string
  args?: unknown
  result?: unknown
}

const SEARCH_TOOLS = new Set([
  'search_tool_library',
  'search_existing_designs',
  'search_parts_library',
  'search_parts',
  'lookup_component_catalog',
])

const MUTATION_TOOLS = new Set([
  'add_session_tool',
  'set_manufacturing_scope',
  'propose_requirement',
  'propose_new_part',
  'add_existing_to_bom',
  'set_bom_parent',
  'set_part_interfaces',
  'set_assembly_interface_mappings',
  'link_requirement_to_part',
  'assign_manufacturing',
  'apply_mechanism_template',
])

function parseToolEntry(content: string): ParsedToolEntry | null {
  try {
    const parsed = JSON.parse(content) as unknown
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'toolName' in parsed &&
      typeof (parsed as { toolName: unknown }).toolName === 'string'
    ) {
      return parsed as ParsedToolEntry
    }
  } catch {
    return null
  }
  return null
}

function formatArgs(args: unknown): string {
  if (args === undefined || args === null) return ''
  if (typeof args !== 'object') return JSON.stringify(args)
  const obj = args as Record<string, unknown>
  const pairs: Array<string> = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue
    if (typeof v === 'string') {
      pairs.push(`${k}: ${JSON.stringify(v)}`)
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      pairs.push(`${k}: ${String(v)}`)
    } else if (Array.isArray(v)) {
      pairs.push(`${k}: [${v.length} items]`)
    } else {
      pairs.push(`${k}: …`)
    }
  }
  return pairs.join(', ')
}

function describeResult(toolName: string, result: unknown): string {
  if (result === undefined || result === null) return 'no result'
  if (typeof result !== 'object') return String(result)
  const obj = result as Record<string, unknown>

  if (SEARCH_TOOLS.has(toolName)) {
    if (typeof obj.total === 'number') {
      return `${obj.total} result${obj.total === 1 ? '' : 's'}`
    }
    for (const key of ['tools', 'items', 'parts', 'designs']) {
      const v = obj[key]
      if (Array.isArray(v)) {
        return `${v.length} result${v.length === 1 ? '' : 's'}`
      }
    }
    return 'unknown count'
  }

  if (MUTATION_TOOLS.has(toolName)) {
    if (typeof obj.name === 'string') return `added "${obj.name}"`
    if (typeof obj.tempId === 'string') return `tempId=${obj.tempId}`
    if (obj.added === true || obj.acknowledged === true) return 'applied'
    if (obj.linked === true) return 'linked'
    if (typeof obj.scope === 'string') return `scope=${obj.scope}`
    return 'applied'
  }

  if (typeof obj.acknowledged === 'boolean') {
    return obj.acknowledged ? 'acknowledged' : 'declined'
  }
  return 'completed'
}

/**
 * Walks llmHistory and produces a deduplicated, ordered bullet list of prior
 * tool calls with their outcomes. Returns an empty string if there's nothing
 * to summarize so callers can omit the prompt section entirely.
 */
export function summarizeToolCalls(
  history: Array<LlmHistoryEntry> | null | undefined,
): string {
  if (!history || history.length === 0) return ''

  const toolEntries: Array<ParsedToolEntry> = []
  for (const entry of history) {
    if (entry.role !== 'tool') continue
    const parsed = parseToolEntry(entry.content)
    if (parsed) toolEntries.push(parsed)
  }

  if (toolEntries.length === 0) return ''

  // Pair each "call" (has args, no result) with the next entry sharing the
  // same toolName that has a result.
  const lines: Array<string> = []
  const seen = new Set<string>()
  const used = new Set<number>()

  for (let i = 0; i < toolEntries.length; i++) {
    if (used.has(i)) continue
    const entry = toolEntries[i]
    if (entry.result !== undefined) continue
    if (entry.args === undefined) continue

    let resultDesc = 'no result captured'
    for (let j = i + 1; j < toolEntries.length; j++) {
      if (used.has(j)) continue
      const candidate = toolEntries[j]
      if (candidate.toolName !== entry.toolName) continue
      if (candidate.result === undefined) continue
      resultDesc = describeResult(entry.toolName, candidate.result)
      used.add(j)
      break
    }

    const argsText = formatArgs(entry.args)
    const line = `- \`${entry.toolName}(${argsText})\` → ${resultDesc}`
    if (!seen.has(line)) {
      lines.push(line)
      seen.add(line)
    }
  }

  if (lines.length === 0) return ''

  return [
    '## Prior Tool Calls',
    'These tool calls already ran in this session. Their results still hold — do NOT repeat them. Use them as background instead of re-searching.',
    '',
    ...lines,
  ].join('\n')
}
