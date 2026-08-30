// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Secret encryption — fail-closed decryption
 *
 * Security gate: decryptSecret decides what gets sent upstream as a bearer
 * token. Its predecessor was `try { decrypt(v) } catch { return v }` at every
 * call site, which meant a rotated or missing ENCRYPTION_KEY silently shipped
 * raw ciphertext to the provider.
 *
 * Invariants: what we encrypt round-trips; ciphertext written before the
 * version prefix still decrypts; a secret we cannot read raises rather than
 * passing through; and a plaintext key stored before encryption was switched on
 * is still returned untouched.
 *
 * Run: npx vitest run packages/core/src/lib/crypto/encryption.test.ts
 */

import crypto from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decryptSecret, encrypt, isEncryptionConfigured } from './encryption'
import { SecretDecryptionError } from '@/lib/errors'

const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)

/** What `encrypt` produced before the `enc:v1:` prefix existed. */
function legacyEncrypt(plaintext: string, hexKey: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(
    'aes-256-gcm',
    Buffer.from(hexKey, 'hex'),
    iv,
  )
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}

describe('decryptSecret', () => {
  const originalKey = process.env.ENCRYPTION_KEY

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY_A
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = originalKey
  })

  it('round-trips a secret through the versioned format', () => {
    const ciphertext = encrypt('sk-live-abcdefghijklmnop')

    expect(ciphertext.startsWith('enc:v1:')).toBe(true)
    expect(decryptSecret(ciphertext)).toBe('sk-live-abcdefghijklmnop')
  })

  it('still reads ciphertext written before the version prefix', () => {
    const legacy = legacyEncrypt('sk-live-abcdefghijklmnop', KEY_A)

    expect(legacy.startsWith('enc:v1:')).toBe(false)
    expect(decryptSecret(legacy)).toBe('sk-live-abcdefghijklmnop')
  })

  it('raises rather than returning ciphertext when the key was rotated', () => {
    const ciphertext = encrypt('sk-live-abcdefghijklmnop')
    process.env.ENCRYPTION_KEY = KEY_B

    expect(() => decryptSecret(ciphertext)).toThrow(SecretDecryptionError)
  })

  it('raises on the same value when ENCRYPTION_KEY is gone entirely', () => {
    const ciphertext = encrypt('sk-live-abcdefghijklmnop')
    delete process.env.ENCRYPTION_KEY

    expect(isEncryptionConfigured()).toBe(false)
    expect(() => decryptSecret(ciphertext)).toThrow(SecretDecryptionError)
  })

  it('raises on corrupt ciphertext instead of passing it through', () => {
    const ciphertext = encrypt('sk-live-abcdefghijklmnop')
    const corrupted = `${ciphertext.slice(0, -5)}AAAA=`

    expect(() => decryptSecret(corrupted)).toThrow(SecretDecryptionError)
  })

  describe('secrets stored before encryption was switched on', () => {
    it.each([
      ['an OpenAI key', 'sk-proj-0123456789abcdefghijklmnopqrstuvwxyz'],
      ['an Anthropic key', 'sk-ant-api03-0123456789abcdefghijklmnop'],
      ['a prefixed vendor key', 'key-0123456789abcdefghijklmnopqrstuv'],
      ['a Google AI Studio key', 'AIzaSyD-0123456789abcdefghijklmnopqrstu'],
      ['a short opaque key', 'zoo-live-7f3a91'],
    ])('passes %s through untouched', (_label, plaintext) => {
      expect(decryptSecret(plaintext)).toBe(plaintext)
    })

    it('passes them through even with no ENCRYPTION_KEY set', () => {
      delete process.env.ENCRYPTION_KEY

      expect(decryptSecret('sk-proj-0123456789abcdefghijklmnop')).toBe(
        'sk-proj-0123456789abcdefghijklmnop',
      )
    })

    it('raises on one shaped exactly like ciphertext, by design', () => {
      // The known limit of the heuristic: an unprefixed plaintext secret long
      // enough for an IV and a tag, padded to a multiple of four, and free of
      // `-` and `_` is indistinguishable from legacy ciphertext. Erring toward
      // "raise and make someone re-save it" beats erring toward "send it
      // upstream as a bearer token", so this is pinned rather than fixed.
      const indistinguishable = 'A'.repeat(48)

      expect(() => decryptSecret(indistinguishable)).toThrow(
        SecretDecryptionError,
      )
    })
  })
})
