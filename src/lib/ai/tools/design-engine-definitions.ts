/**
 * AI Tool Definition: initiate_collaborative_design
 *
 * Triggers the collaborative design workflow when a user wants to
 * design something new or substantially modify an existing design.
 * Creates the session immediately (no confirmation step needed).
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

export const initiateCollaborativeDesignDef = toolDefinition({
  name: 'initiate_collaborative_design',
  description: `Start a collaborative design session when the user wants to design something new or substantially modify an existing design. This launches an interactive workspace that guides the user through: requirements gathering -> BOM structure -> materialization into real PLM data. Use this when the user describes a product, assembly, or system they want to design and needs help breaking it down into requirements and a bill of materials. IMPORTANT: Always pass the programId (UUID from search_programs). Call search_programs first if needed.`,
  inputSchema: z.object({
    description: z
      .string()
      .describe(
        'Description of what the user wants to design. Capture the full context from the conversation.',
      ),
    programId: z
      .string()
      .describe(
        'Program UUID (from search_programs) or program code. REQUIRED.',
      ),
    designId: z
      .string()
      .optional()
      .describe(
        'Existing design ID to add to (optional, creates new if omitted)',
      ),
  }),
  outputSchema: z.object({
    sessionId: z.string().optional(),
    workspaceUrl: z.string().optional(),
    action: z.string().optional(),
    error: z.string().optional(),
  }),
})

export type InitiateCollaborativeDesignInput = z.infer<
  typeof initiateCollaborativeDesignDef.inputSchema
>

export type InitiateCollaborativeDesignOutput = z.infer<
  typeof initiateCollaborativeDesignDef.outputSchema
>
