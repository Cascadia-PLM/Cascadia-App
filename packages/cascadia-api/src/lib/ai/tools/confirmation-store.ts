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
 * Honest threat model: this proves the preview step happened recently with
 * identical parameters. It cannot prove a human approved — surfacing the
 * preview and collecting the approval remains the client/agent's contract.
 *
 * Storage is a small table rather than process memory because deployments
 * may run several app instances; the token pattern (opaque value, hashed at
 * rest) mirrors sessions.
 */

import { createHash, randomBytes } from 'node:crypto'
import { and, eq, gt, isNull, lt } from 'drizzle-orm'
import { db } from '@/lib/db'
import { aiWriteConfirmations } from '@/lib/db/schema/ai'

/** How long a preview's token stays redeemable. */
const CONFIRMATION_TTL_MS = 5 * 60 * 1000

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

/**
 * Mint a token for a preview the server just produced. The raw token goes to
 * the caller (and only there); the row stores its hash. Expired rows are
 * swept opportunistically here rather than by a scheduled job.
 */
export async function issueConfirmationToken(
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
): Promise<string> {
  await db
    .delete(aiWriteConfirmations)
    .where(lt(aiWriteConfirmations.expiresAt, new Date()))

  const token = randomBytes(32).toString('base64url')
  await db.insert(aiWriteConfirmations).values({
    tokenHash: sha256Hex(token),
    userId,
    toolName,
    paramsHash: hashConfirmationParams(input),
    expiresAt: new Date(Date.now() + CONFIRMATION_TTL_MS),
  })
  return token
}

/**
 * Redeem a token for execution. One atomic UPDATE marks it used — under a
 * concurrent double-redeem exactly one caller gets the row — and the
 * user/tool/params bindings are verified after the claim, so a mismatched
 * attempt burns the token rather than leaving it live.
 */
export async function redeemConfirmationToken(
  userId: string,
  toolName: string,
  input: Record<string, unknown>,
  token: string,
): Promise<boolean> {
  const claimed = await db
    .update(aiWriteConfirmations)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(aiWriteConfirmations.tokenHash, sha256Hex(token)),
        isNull(aiWriteConfirmations.usedAt),
        gt(aiWriteConfirmations.expiresAt, new Date()),
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
