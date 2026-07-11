/**
 * Requirements Stage Tools
 *
 * Tools available to the LLM during the requirements generation stage.
 * Reuses existing PLM search handlers and adds stage-specific tools.
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'
import { toolErrorMessage } from './tool-utils'
import type { ToolContext } from '@/lib/ai/tools/permission-wrapper'
import type { RequirementDraft } from '../types'
import {
  searchDesignsHandler,
  searchItemsHandler,
} from '@/lib/ai/tools/handlers'

/** Create tool definitions for the requirements stage */
export function createRequirementsTools(
  context: ToolContext,
  // Returns the resulting tempId and whether a new requirement was added; the
  // stage owns dedup (a re-proposed name returns the existing tempId, and a
  // match against a user-rejected requirement is flagged back to the LLM).
  onPropose: (requirement: RequirementDraft) => {
    tempId: string
    added: boolean
    rejectedByUser?: boolean
    message?: string
  },
  onClarification: (
    questionId: string,
    question: string,
    options?: Array<string>,
    multiSelect?: boolean,
  ) => void,
) {
  const searchExistingDesigns = toolDefinition({
    name: 'search_existing_designs',
    description:
      'Search for existing designs in the PLM system that may be similar to what is being designed.',
    inputSchema: z.object({
      query: z.string().describe('Search query for design names or codes'),
      limit: z.number().optional().describe('Max results (default 10)'),
    }),
    outputSchema: z.object({
      designs: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
      error: z.string().optional(),
    }),
  }).server(async (input) => {
    try {
      const result = await searchDesignsHandler(
        { query: input.query, limit: input.limit ?? 10 },
        context,
      )
      return result as {
        designs: Array<Record<string, unknown>>
        total: number
      }
    } catch (err) {
      return { designs: [], total: 0, error: toolErrorMessage(err) }
    }
  })

  const searchPartsLibrary = toolDefinition({
    name: 'search_parts_library',
    description:
      'Search for existing parts in the PLM standard library that might be reused.',
    inputSchema: z.object({
      query: z.string().describe('Search query for part names or numbers'),
      itemType: z
        .enum(['Part', 'Document', 'Requirement'])
        .optional()
        .describe('Filter by item type'),
      limit: z.number().optional().describe('Max results (default 10)'),
    }),
    outputSchema: z.object({
      items: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
      error: z.string().optional(),
    }),
  }).server(async (input) => {
    try {
      const result = await searchItemsHandler(
        {
          query: input.query,
          itemType: input.itemType,
          limit: input.limit ?? 10,
        },
        context,
      )
      return result as { items: Array<Record<string, unknown>>; total: number }
    } catch (err) {
      return { items: [], total: 0, error: toolErrorMessage(err) }
    }
  })

  const proposeRequirement = toolDefinition({
    name: 'propose_requirement',
    description:
      'Propose a new requirement for the design. Each requirement should be specific, measurable where possible, and traceable.',
    inputSchema: z.object({
      name: z.string().describe('Short requirement name'),
      description: z
        .string()
        .describe('Detailed description with acceptance criteria'),
      requirementType: z
        .enum(['Functional', 'Performance', 'Interface', 'Constraint', 'Other'])
        .describe('Category of requirement'),
      priority: z
        .enum(['low', 'medium', 'high', 'critical'])
        .describe('Priority level'),
      verificationMethod: z
        .enum(['Analysis', 'Inspection', 'Test', 'Demonstration'])
        .describe('How this requirement will be verified'),
      rationale: z.string().describe('Why this requirement is needed'),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .describe('Confidence level 0-1 that this requirement is needed'),
    }),
    outputSchema: z.object({
      tempId: z.string(),
      added: z.boolean(),
      rejectedByUser: z.boolean().optional(),
      message: z.string().optional(),
    }),
  }).server((input) => {
    const requirement: RequirementDraft = {
      tempId: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      requirementType: input.requirementType,
      priority: input.priority,
      verificationMethod: input.verificationMethod,
      rationale: input.rationale,
      confidence: input.confidence,
      source: 'ai',
      reviewStatus: 'proposed',
    }
    // Stage-owned dedup: a re-proposed name returns the existing tempId.
    return onPropose(requirement)
  })

  const askClarification = toolDefinition({
    name: 'ask_clarification',
    description:
      'Ask the user a clarification question about the design when more information is needed to generate accurate requirements. ALWAYS provide `options` when the answer is a known choice from a finite set. Set `multiSelect: true` when more than one option can apply ("select all that apply").',
    inputSchema: z.object({
      question: z
        .string()
        .describe(
          'The question to ask the user. Keep it concise — options are rendered separately, so do not embed an inline list of choices in the question text.',
        ),
      options: z
        .array(z.string())
        .optional()
        .describe(
          'Suggested answers, presented as buttons or checkboxes. Provide these whenever the answer is a known choice from a finite set.',
        ),
      multiSelect: z
        .boolean()
        .optional()
        .describe(
          'True when the user can pick more than one option ("select all that apply"). Defaults to false (single choice).',
        ),
    }),
    outputSchema: z.object({
      acknowledged: z.boolean(),
    }),
  }).server((input) => {
    const questionId = crypto.randomUUID()
    onClarification(questionId, input.question, input.options, input.multiSelect)
    return { acknowledged: true }
  })

  return [
    searchExistingDesigns,
    searchPartsLibrary,
    proposeRequirement,
    askClarification,
  ]
}
