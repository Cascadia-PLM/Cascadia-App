// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * AES-256-GCM encryption for sensitive data at rest (e.g., API keys).
 *
 * Requires ENCRYPTION_KEY environment variable (32 bytes as 64 hex chars).
 * Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import crypto from 'node:crypto'
import { SecretDecryptionError } from '@/lib/errors'
import { cryptoLogger } from '@/lib/logging/logger'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const TAG_LENGTH = 16

/**
 * Marks a value as our ciphertext.
 *
 * Without it, telling ciphertext from a plaintext secret is guesswork, and the
 * guess has to be made every time a stored secret is read. Values written
 * before this prefix existed are still accepted on the way in — see
 * `looksLikeCiphertext`.
 */
const CIPHERTEXT_PREFIX = 'enc:v1:'

/**
 * Prefixes that identify a provider's plaintext key beyond doubt, so a row
 * written before encryption was switched on keeps working.
 */
const PLAINTEXT_KEY_PREFIXES = ['sk-', 'key-']

/** Shortest base64 our format can produce: a 12-byte IV + 16-byte tag. */
const MIN_CIPHERTEXT_BASE64_LENGTH = Math.ceil((IV_LENGTH + TAG_LENGTH) / 3) * 4

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key) {
    throw new Error(
      'ENCRYPTION_KEY environment variable is required for encrypting sensitive data',
    )
  }
  return Buffer.from(key, 'hex')
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns `enc:v1:` followed by base64 of IV + auth tag + ciphertext.
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return (
    CIPHERTEXT_PREFIX + Buffer.concat([iv, tag, encrypted]).toString('base64')
  )
}

/**
 * Decrypt a string produced by `encrypt`, with or without the version prefix.
 *
 * Throws on anything it cannot decrypt. Prefer `decryptSecret` for values read
 * out of storage — it is the one that knows what a pre-encryption plaintext
 * looks like.
 */
export function decrypt(ciphertext: string): string {
  const key = getEncryptionKey()
  const payload = ciphertext.startsWith(CIPHERTEXT_PREFIX)
    ? ciphertext.slice(CIPHERTEXT_PREFIX.length)
    : ciphertext
  const data = Buffer.from(payload, 'base64')
  const iv = data.subarray(0, IV_LENGTH)
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted).toString('utf8') + decipher.final('utf8')
}

/**
 * Whether a stored value is one of ours, as opposed to a secret written before
 * encryption was switched on.
 *
 * Prefixed values are certain. For legacy unprefixed ones the test is the shape
 * `encrypt` produced: strict base64 (no base64url, and a length that is a
 * multiple of four), long enough to hold an IV and an auth tag. A provider key
 * has to be long, padded to a multiple of four, and free of `-` and `_` to be
 * mistaken for ciphertext — and a value that clears all three still fails
 * loudly at `decryptSecret` rather than being sent upstream as-is.
 */
function looksLikeCiphertext(value: string): boolean {
  if (value.startsWith(CIPHERTEXT_PREFIX)) return true
  if (PLAINTEXT_KEY_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return false
  }
  return (
    value.length >= MIN_CIPHERTEXT_BASE64_LENGTH &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
}

/**
 * Decrypt a secret read out of storage, failing closed.
 *
 * The old shape of this — duplicated at every call site — was
 * `try { return decrypt(v) } catch { return v }`. That is fine for the case it
 * was written for (a row predating encryption) and quietly wrong for the case
 * that actually happens: rotate or drop ENCRYPTION_KEY and every decrypt fails,
 * so raw ciphertext goes upstream as the bearer token and the operator spends
 * the afternoon reading the provider's 401s instead of the one config error
 * that explains them.
 *
 * So: a value that is plainly not ciphertext is returned untouched, and a value
 * that is ciphertext either decrypts or throws.
 */
export function decryptSecret(value: string): string {
  if (!looksLikeCiphertext(value)) return value

  if (!isEncryptionConfigured()) {
    const reason = 'ENCRYPTION_KEY is not set'
    cryptoLogger.error(`Secret decryption failed: ${reason}`)
    throw new SecretDecryptionError(reason)
  }

  try {
    return decrypt(value)
  } catch (cause) {
    const reason =
      cause instanceof Error ? cause.message : 'unrecognised ciphertext'
    cryptoLogger.error({ err: cause }, `Secret decryption failed: ${reason}`)
    throw new SecretDecryptionError(reason)
  }
}

/**
 * Check if the ENCRYPTION_KEY is configured.
 */
export function isEncryptionConfigured(): boolean {
  return !!process.env.ENCRYPTION_KEY
}
