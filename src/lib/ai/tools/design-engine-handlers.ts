/**
 * AI Tool Handler: initiate_collaborative_design
 *
 * Creates a design session and returns a workspace URL.
 * No confirmation step — creating a session is lightweight and non-destructive.
 *
 * When no program is specified (or it can't be resolved / accessed), the
 * handler returns the user's accessible programs and whether they may create
 * a new one, so the assistant can suggest options instead of dead-ending.
 */

import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { withWritePermissionAndAudit } from './permission-wrapper'
import type { ToolContext, WriteOperationMeta } from './permission-wrapper'
import { DesignSessionService } from '@/lib/design-engine/session-service'
import { db } from '@/lib/db'
import { programs } from '@/lib/db/schema'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { permissionService } from '@/lib/auth/permission-service'
import { DesignService } from '@/lib/services/DesignService'

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
  availablePrograms?: Array<{ id: string; name: string; code: string }>
  canCreateProgram?: boolean
}

/**
 * Build the "pick or create a program" response: the user's accessible
 * programs plus whether they're allowed to create a new one.
 */
async function programOptionsResponse(
  userId: string,
  error: string,
): Promise<InitiateOutput> {
  const accessible = await AccessControlService.getAccessiblePrograms(userId)
  const canCreateProgram = await permissionService.canUser(
    userId,
    'create',
    'programs',
  )

  return {
    error,
    availablePrograms: accessible
      .slice(0, 20)
      .map((p) => ({ id: p.id, name: p.name, code: p.code })),
    canCreateProgram,
  }
}

async function initiateCollaborativeDesignImpl(
  input: InitiateInput,
  context: ToolContext,
): Promise<InitiateOutput> {
  // Prefer programId from input (LLM looked it up), fall back to session context
  const rawProgramId = input.programId || context.programId
  if (!rawProgramId) {
    return programOptionsResponse(
      context.userId,
      'A program is required to start a design session. Ask the user to pick one of availablePrograms, or offer to create a new program (create_program) if canCreateProgram is true.',
    )
  }

  // Resolve program: accept UUID or code
  const programId = await resolveProgramId(rawProgramId)
  if (!programId) {
    return programOptionsResponse(
      context.userId,
      `Could not find program "${rawProgramId}". Ask the user to pick one of availablePrograms, or offer to create a new program (create_program) if canCreateProgram is true.`,
    )
  }

  // The user must be a member of the program (or a global admin)
  const canAccess = await AccessControlService.canAccessProgram(
    context.userId,
    programId,
  )
  if (!canAccess) {
    return programOptionsResponse(
      context.userId,
      `You don't have access to program "${rawProgramId}". Ask the user to pick one of availablePrograms instead.`,
    )
  }

  // If a target design was given, it must exist and belong to the program —
  // materialization will create items in it.
  if (input.designId) {
    const design = await DesignService.getById(input.designId)
    if (!design) {
      return {
        error: `Could not find design "${input.designId}". Omit designId to create a new design, or use search_designs to find the right one.`,
      }
    }
    if (design.programId !== programId) {
      return {
        error: `Design "${design.name}" belongs to a different program. Pass the design's own program as programId, or omit designId to create a new design.`,
      }
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
