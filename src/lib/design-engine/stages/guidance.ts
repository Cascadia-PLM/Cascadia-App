/**
 * Mid-stream steering support for drafting stages.
 *
 * A running stage loop cannot receive input over its own HTTP request, so
 * steering messages land in the session's `pending_guidance` mailbox (a
 * dedicated column — the artifacts blob has competing writers). The stage
 * loop polls the mailbox through this throttled checker at tool-call
 * boundaries and, on a hit, restarts its chat() with the guidance injected.
 */

import { DesignSessionService } from '../session-service'
import type { UserMessage } from '../types'

export interface GuidanceChecker {
  /**
   * Drain the mailbox if the throttle interval has elapsed; otherwise a
   * no-op returning []. Safe to call from tight chunk loops.
   */
  maybeDrain: () => Promise<Array<UserMessage>>
  /** Drain unconditionally (used at stage start/resume). */
  drain: () => Promise<Array<UserMessage>>
}

export function createGuidanceChecker(
  sessionId: string,
  minIntervalMs = 2500,
): GuidanceChecker {
  let lastCheck = 0

  const drain = () => DesignSessionService.drainGuidance(sessionId)

  return {
    async maybeDrain() {
      const now = Date.now()
      if (now - lastCheck < minIntervalMs) return []
      lastCheck = now
      return drain()
    },
    drain,
  }
}

/** The user-turn text injected when a steering continuation restarts chat(). */
export function buildSteeringUserMessage(
  messages: Array<UserMessage>,
): string {
  const lines = messages.map((m) => `- ${m.text}`).join('\n')
  return `The user just sent new guidance while you were working:\n${lines}\n\nAdjust your remaining work to follow this guidance. Do not re-propose items that already exist; revise or remove them if the guidance requires it.`
}
