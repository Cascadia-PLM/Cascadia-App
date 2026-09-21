// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { SessionService } from './SessionService'
import { AccessControlService } from '@/lib/auth/AccessControlService'
import { requireDesignAccess } from '@/lib/auth/access'
import { PermissionDeniedError } from '@/lib/errors'

/**
 * Which program an AI chat request spends against, and whether the caller may.
 *
 * The chat route used to take `programId` from the request body and hand it
 * straight to `isAIEnabled`, `loadProviderConfig` — the API key and monthly
 * token budget live there — and `createSession`, which stored it. Nothing
 * checked membership, so a non-member could name any program and spend its
 * key, exhaust its budget, and read its name back out of the system prompt.
 * The usage row was attributed to that program too, so the spend looked like
 * the victim's own.
 *
 * Two rules settle it:
 *
 *   - **An existing session's own `programId` wins.** Ownership of the session
 *     is already verified, and the program it was created under is the scope it
 *     was created under; a body value that disagrees is ignored rather than
 *     honoured. That keeps the in-app client — which sends both — working
 *     unchanged.
 *   - **A new session's `programId` must be one the caller can reach**, the
 *     same `canAccessProgram` check the design-engine session route makes.
 *     `designId` is gated with `requireDesignAccess` for the same reason.
 *
 * A session with **no** program is deliberately still allowed: it resolves to
 * the GLOBAL provider configuration and budget, which is the instance admin's
 * own, not any program's. That is a decision, not an oversight — a user with
 * no program should still be able to ask the assistant a question.
 */
export interface ChatScope {
  /** The session to continue, or null when one must be created. */
  sessionId: string | null
  /**
   * The program every downstream decision uses — provider config, budget,
   * usage attribution, system-prompt context. Null means the global config.
   */
  programId: string | null
  /** The design context, under the same rule. */
  designId: string | null
}

export interface ChatScopeRequest {
  sessionId?: string | null
  programId?: string | null
  designId?: string | null
}

/**
 * The subset of `SessionService` this needs, so the rule can be unit-tested
 * without standing up a chat request.
 */
export type ChatScopeSessions = Pick<
  SessionService,
  'verifySessionOwnership' | 'getSession'
>

export async function resolveChatScope(
  userId: string,
  input: ChatScopeRequest,
  sessions: ChatScopeSessions,
): Promise<ChatScope> {
  if (input.sessionId) {
    const isOwner = await sessions.verifySessionOwnership(
      input.sessionId,
      userId,
    )
    if (!isOwner) {
      throw new PermissionDeniedError('session', 'access')
    }

    const session = await sessions.getSession(input.sessionId)
    if (session) {
      // The session's own scope, not the body's. A caller cannot re-point an
      // existing conversation at another program's key by sending a different
      // programId alongside its id.
      return {
        sessionId: session.id,
        programId: session.programId,
        designId: session.designId,
      }
    }
    // The id named a session that has since gone. Fall through and create a
    // fresh one under the body's scope, which is checked below.
  }

  const programId = input.programId ?? null
  const designId = input.designId ?? null

  if (programId) {
    const canAccess = await AccessControlService.canAccessProgram(
      userId,
      programId,
    )
    if (!canAccess) {
      throw new PermissionDeniedError('program', 'access')
    }
  }

  if (designId) {
    await requireDesignAccess(userId, designId)
  }

  return { sessionId: null, programId, designId }
}
