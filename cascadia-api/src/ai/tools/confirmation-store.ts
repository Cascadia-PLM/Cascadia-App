// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Server-issued single-use confirmation tokens for AI write tools (AI-3).
 *
 * The old flow trusted a model-supplied `confirmed: true` — any agent (or a
 * prompt injection steering one) could skip the preview entirely by setting
 * the flag on the first call. A token forces the preview to have happened:
 * it is minted by the server on the preview response, bound to the user, the
 * tool, and a hash of the exact previewed parameters, expires in minutes,
 * and redeems atomically exactly once.
 *
 * On its own that proves the preview step happened recently with identical
 * parameters, and nothing more: the token is in the tool result, the model
 * reads tool results, and a model that calls twice in one turn has previewed
 * and executed with no person involved. So a token minted for the chat panel
 * is also **approval-gated**: it redeems only once `approvedAt` is set, and
 * the only thing that sets it is `respondToConfirmation`, reached through an
 * authenticated HTTP request from the user's browser when they click Confirm.
 * A tool call cannot make that request. What executes is still exactly what
 * the card showed, because the parameter hash is unchanged.
 *
 * Over MCP there is no panel to click in, so tokens there are not gated:
 * surfacing the preview and collecting the approval remains the external
 * agent's contract, as before.
 *
 * Storage is a small table rather than process memory because deployments
 * may run several app instances; the token pattern (opaque value, hashed at
 * rest) mirrors sessions.
 */

import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { db } from '@/db'
import { aiWriteConfirmations } from '@/db/schema/ai'

/** How long an ungated preview's token stays redeemable. */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000

/**
 * How long a person has to answer a card. Longer than the ungated window
 * because it is spent reading, not in a model's next call — five minutes
 * expired under anyone who looked something up first.
 */
const APPROVAL_TTL_MS = 15 * 60 * 1000

/** Once approved, how long the model has to make the confirmed call. */
const APPROVED_REDEEM_TTL_MS = 5 * 60 * 1000

/** Input keys that are part of the confirmation plumbing, not the operation. */
const CONFIRMATION_FIELDS = new Set(['confirmationToken', 'confirmed'])

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Canonical JSON: object keys sorted at every depth, `undefined` members
 * dropped — so two inputs that differ only in key order or absent-vs-
 * undefined fields hash identically.
 */
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v ?? null)).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(',')}}`
}

/** Hash the operation parameters, excluding the confirmation fields. */
export function hashConfirmationParams(input: Record<string, unknown>): string {
  const operational = Object.fromEntries(
    Object.entries(input).filter(([key]) => !CONFIRMATION_FIELDS.has(key)),
  )
  return sha256Hex(canonicalize(operational))
}

/** A token that is still live: issued, unspent, unexpired. */
function liveToken(token: string) {
  return and(
    eq(aiWriteConfirmations.tokenHash, sha256Hex(token)),
    isNull(aiWriteConfirmations.usedAt),
    gt(aiWriteConfirmations.expiresAt, new Date()),
  )
}

/**
 * Mint a token for a preview the server just produced. The raw token goes to
 * the caller (and only there); the row stores its hash. Expired rows are
 * swept opportunistically here rather than by a scheduled job.
 *
 * `requiresApproval` marks a preview shown to a person: see the module note.
 */
export async function issueConfirmationToken(
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
  options: { requiresApproval?: boolean } = {},
): Promise<string> {
  await db
    .delete(aiWriteConfirmations)
    .where(lt(aiWriteConfirmations.expiresAt, new Date()))

  const requiresApproval = options.requiresApproval ?? false
  const token = randomBytes(32).toString('base64url')
  await db.insert(aiWriteConfirmations).values({
    tokenHash: sha256Hex(token),
    userId,
    toolName,
    paramsHash: hashConfirmationParams(input),
    requiresApproval,
    expiresAt: new Date(
      Date.now() + (requiresApproval ? APPROVAL_TTL_MS : CONFIRMATION_TTL_MS),
    ),
  })
  return token
}

/**
 * Record the user's own answer to a preview. This is the half of the flow a
 * model cannot perform: the caller is the route behind the panel's Confirm
 * and Cancel buttons, authenticated as `userId`.
 *
 * Approving starts a fresh, short redeem window — the wait for a person is
 * over, and what is left is one model call. Cancelling spends the token, so
 * a model that repeats the call anyway gets a new preview, not an execution.
 *
 * `false` for anything that is not this user's live token: unknown, expired,
 * already used, or someone else's. One answer for all four, so the endpoint
 * says nothing about which tokens exist.
 */
export async function respondToConfirmation(
  userId: string,
  token: string,
  approved: boolean,
): Promise<boolean> {
  const now = new Date()
  const answered = await db
    .update(aiWriteConfirmations)
    .set(
      approved
        ? {
            approvedAt: now,
            expiresAt: new Date(now.getTime() + APPROVED_REDEEM_TTL_MS),
          }
        : { usedAt: now },
    )
    .where(and(liveToken(token), eq(aiWriteConfirmations.userId, userId)))
    .returning({ tokenHash: aiWriteConfirmations.tokenHash })

  return answered.length > 0
}

/**
 * Whether this is the user's live token for a preview they have not answered.
 * Reads only: the handlers ask before redeeming so that an early repeat of
 * the call neither spends the token nor mints a second card.
 */
export async function isAwaitingApproval(
  userId: string,
  token: string,
): Promise<boolean> {
  const row = await db.query.aiWriteConfirmations.findFirst({
    where: and(
      liveToken(token),
      eq(aiWriteConfirmations.userId, userId),
      eq(aiWriteConfirmations.requiresApproval, true),
      isNull(aiWriteConfirmations.approvedAt),
    ),
    columns: { tokenHash: true },
  })
  return row !== undefined
}

/**
 * Redeem a token for execution. One atomic UPDATE marks it used — under a
 * concurrent double-redeem exactly one caller gets the row — and the
 * user/tool/params bindings are verified after the claim, so a mismatched
 * attempt burns the token rather than leaving it live.
 *
 * An approval-gated token is not claimable until it has been approved, and
 * `requireApproved` demands an approval whatever the row says: the chat
 * surface passes it, so a token minted ungated elsewhere cannot be spent
 * there. Either way the unapproved token is left live, not burned — the
 * person may still be about to answer it.
 */
export async function redeemConfirmationToken(
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
  token: string,
  options: { requireApproved?: boolean } = {},
): Promise<boolean> {
  const approved = isNotNull(aiWriteConfirmations.approvedAt)
  const claimed = await db
    .update(aiWriteConfirmations)
    .set({ usedAt: new Date() })
    .where(
      and(
        liveToken(token),
        options.requireApproved
          ? approved
          : or(eq(aiWriteConfirmations.requiresApproval, false), approved),
      ),
    )
    .returning()

  const row = claimed.at(0)
  if (!row) return false

  return (
    row.userId === userId &&
    row.toolName === toolName &&
    row.paramsHash === hashConfirmationParams(input)
  )
}
