/**
 * AI Tool Handler: initiate_collaborative_design
 *
 * Creates a design session and returns a workspace URL.
 * No confirmation step — creating a session is lightweight and non-destructive.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { withWritePermissionAndAudit } from './permission-wrapper'
import type { ToolContext, WriteOperationMeta } from './permission-wrapper'
import { DesignSessionService } from '@/lib/design-engine/session-service'
import { db } from '@/lib/db'
import { programs } from '@/lib/db/schema'

interface InitiateInput {
  description: string
  programId?: string
  designId?: string
}

interface InitiateOutput {
  sessionId?: string
  workspaceUrl?: string
  action?: string
  error?: string
}

async function initiateCollaborativeDesignImpl(
  input: InitiateInput,
  context: ToolContext,
): Promise<InitiateOutput> {
  // Prefer programId from input (LLM looked it up), fall back to session context
  const rawProgramId = input.programId || context.programId
  if (!rawProgramId) {
    return {
      error:
        'A program is required to start a design session. Please specify which program to use.',
    }
  }

  // Resolve program: accept UUID or code
  const programId = await resolveProgramId(rawProgramId)
  if (!programId) {
    return {
      error: `Could not find program "${rawProgramId}". Please check the program ID or code.`,
    }
  }

  const session = await DesignSessionService.create(context.userId, {
    description: input.description,
    programId,
    designId: input.designId,
    aiChatSessionId: context.sessionId,
  })

  return {
    sessionId: session.id,
    workspaceUrl: `/designs/collaborative/${session.id}`,
    action: 'open_design_workspace',
  }
}

export const initiateCollaborativeDesignHandler = (
  input: InitiateInput,
  context: ToolContext,
) => {
  const meta: WriteOperationMeta = {
    actionType: 'create_design_session',
    affectedItemIds: [],
    wasConfirmed: true,
    transactionId: randomUUID(),
  }

  return withWritePermissionAndAudit<InitiateInput, InitiateOutput>(
    'initiate_collaborative_design',
    { resource: 'parts', action: 'create' },
    initiateCollaborativeDesignImpl,
  )(input, context, meta)
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Resolve a program UUID or code to a UUID. Returns null if not found. */
async function resolveProgramId(idOrCode: string): Promise<string | null> {
  if (UUID_RE.test(idOrCode)) {
    // Already a UUID — verify it exists
    const result = await db
      .select({ id: programs.id })
      .from(programs)
      .where(eq(programs.id, idOrCode))
      .limit(1)
    return result[0]?.id ?? null
  }

  // Try looking up by code
  const result = await db
    .select({ id: programs.id })
    .from(programs)
    .where(eq(programs.code, idOrCode))
    .limit(1)
  return result[0]?.id ?? null
}
