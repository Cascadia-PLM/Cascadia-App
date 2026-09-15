// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { encodeHexLowerCase } from '@oslojs/encoding'
import { encrypt, isEncryptionConfigured } from '@/lib/crypto/encryption'
import { ValidationError } from '@/lib/errors'

/**
 * Signing-secret generation and storage for webhook subscriptions.
 *
 * The secret is generated the way an API key is — a marked prefix plus random
 * hex — so a value that leaks into a log, a config file or a support ticket is
 * greppable as a Cascadia credential rather than being indistinguishable from
 * any other hex blob.
 *
 * Where this departs from `ApiKeyService` is storage, and the departure is
 * forced rather than chosen: an HMAC key has to be recoverable to sign with, so
 * a one-way hash produces a table you cannot send from. The secret is therefore
 * encrypted at rest with the same helpers the AI provider keys use.
 */

const WEBHOOK_SECRET_PREFIX = 'cscwh_'

/** 32 bytes of entropy, hex-encoded — the HMAC-SHA256 block-equivalent. */
const SECRET_BYTES = 32

/** Characters kept for display, matching the API-key convention. */
const DISPLAY_PREFIX_LENGTH = 12

export interface GeneratedWebhookSecret {
  /** Returned to the caller exactly once, at creation or rotation. */
  plaintext: string
  /** What goes in `encrypted_secret`. */
  encrypted: string
  /** What goes in `secret_prefix`, for identification only. */
  prefix: string
}

/**
 * Mint a signing secret, refusing when it could not be stored safely.
 *
 * **This refuses where the admin AI-provider route warns**, and the difference
 * is the whole point. A plaintext provider key leaks a credential the operator
 * already holds somewhere else and can rotate upstream. A plaintext HMAC key
 * lets anyone who can read a table the admin API reads *forge deliveries* into
 * whatever the customer wired the webhook to — an ERP, a ticket queue, a
 * payment system. The blast radius is not the same, so the tolerance is not
 * either.
 *
 * An operator on a trusted network who genuinely does not want signing can
 * still say so, by creating the subscription unsigned. What is refused is the
 * silent middle: a subscription that says it is signed and is not.
 */
export function generateWebhookSecret(): GeneratedWebhookSecret {
  if (!isEncryptionConfigured()) {
    throw new ValidationError(
      'ENCRYPTION_KEY must be set before a signed webhook subscription can be ' +
        'created. Set it, or create the subscription unsigned if this ' +
        'instance is on a trusted network.',
    )
  }

  const bytes = crypto.getRandomValues(new Uint8Array(SECRET_BYTES))
  const plaintext = `${WEBHOOK_SECRET_PREFIX}${encodeHexLowerCase(bytes)}`

  return {
    plaintext,
    encrypted: encrypt(plaintext),
    prefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
  }
}

/**
 * Whether a value looks like one of our secrets.
 *
 * Used by the tests rather than by any code path. The decryption helper's
 * legacy fallback returns a non-ciphertext-shaped value *untouched with no
 * error*, and our prefix contains an underscore, which that fallback's base64
 * pattern rejects — so a plaintext secret that ever reached the column would
 * be signed with silently. A round trip cannot see that (plaintext in,
 * plaintext out); asserting that the stored value carries the ciphertext
 * marker does.
 */
export function looksLikeWebhookSecret(value: string): boolean {
  return value.startsWith(WEBHOOK_SECRET_PREFIX)
}
