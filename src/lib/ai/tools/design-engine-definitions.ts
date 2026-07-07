/**
 * AI Tool Definition: initiate_collaborative_design
 *
 * Triggers the collaborative design workflow when a user wants to
 * design something new or substantially modify an existing design.
 * Creates the session immediately (no confirmation step needed).
 *
 * Program selection is flexible: when called without a programId, the tool
 * returns the user's accessible programs (and whether they may create a new
 * one) so the assistant can suggest options instead of failing.
 */

import { toolDefinition } from '@tanstack/ai'
import { z } from 'zod'

export const initiateCollaborativeDesignDef = toolDefinition({
  name: 'initiate_collaborative_design',
  description: `Start a collaborative design session when the user wants to design something new or substantially modify an existing design. This launches an interactive workspace that guides the user through: requirements gathering -> BOM structure -> materialization into real PLM data. Use this when the user describes a product, assembly, or system they want to design and needs help breaking it down into requirements and a bill of materials.
The session must belong to a program:
- If the user named a program, resolve it (via search_programs or its code) and pass programId.
- If no program is known yet, call this tool WITHOUT programId — it returns availablePrograms (and canCreateProgram) so you can ask the user to pick one or offer to create a new program with create_program. Never invent a programId.`,
  inputSchema: z.object({
    description: z
      .string()
      .describe(
        'Description of what the user wants to design. Capture the full context from the conversation.',
      ),
    programId: z
      .string()
      .optional()
      .describe(
        'Program UUID (from search_programs) or program code. Omit if the user has not chosen a program yet — the tool will return their available programs to choose from.',
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
    availablePrograms: z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          code: z.string(),
        }),
      )
      .optional()
      .describe(
        'Programs the user can start the session in (returned when no program was specified or it was not found). Present these to the user.',
      ),
    canCreateProgram: z
      .boolean()
      .optional()
      .describe(
        'Whether the user has permission to create a new program. If true, offer create_program as an option.',
      ),
  }),
})

export type InitiateCollaborativeDesignInput = z.infer<
  typeof initiateCollaborativeDesignDef.inputSchema
>

export type InitiateCollaborativeDesignOutput = z.infer<
  typeof initiateCollaborativeDesignDef.outputSchema
>
