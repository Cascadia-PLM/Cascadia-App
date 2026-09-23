// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Gate 2: the secret is a signing key, and the two ways to get it wrong are
 * storing it where it cannot be recovered and storing it where it is not
 * protected.
 *
 * One trap shapes these tests. `decryptSecret` routes through a "does this look
 * like our ciphertext" check whose fallback for legacy values is a strict base64
 * pattern — and our secret prefix contains an underscore, which that pattern
 * rejects. So a *plaintext* secret that ever reached the column is returned
 * **untouched with no error**, and the pump would sign with it silently. A round
 * trip cannot see that on its own: plaintext in, the same plaintext out. What
 * catches it is asserting that the stored value is ciphertext, which is why the
 * round trip carries that assertion too.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateWebhookSecret, looksLikeWebhookSecret } from './secret'
import { decryptSecret, isEncryptionConfigured } from '@/lib/crypto/encryption'
import { ValidationError } from '@/lib/errors'

const TEST_KEY = 'a'.repeat(64)

describe('webhook signing secrets', () => {
  let original: string | undefined

  beforeEach(() => {
    original = process.env.ENCRYPTION_KEY
  })

  afterEach(() => {
    if (original === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = original
  })

  describe('with ENCRYPTION_KEY set', () => {
    beforeEach(() => {
      process.env.ENCRYPTION_KEY = TEST_KEY
    })

    it('round-trips the stored value back to the exact plaintext', () => {
      const secret = generateWebhookSecret()

      // The same bytes back. On its own that would pass for a plaintext value
      // too — the fallback returns it untouched — so the stored value has to be
      // ciphertext for the round trip to mean anything.
      expect(secret.encrypted.startsWith('enc:v1:')).toBe(true)
      expect(decryptSecret(secret.encrypted)).toBe(secret.plaintext)
    })

    it('stores ciphertext, not the plaintext', () => {
      const secret = generateWebhookSecret()

      expect(secret.encrypted).not.toBe(secret.plaintext)
      expect(secret.encrypted).not.toContain(secret.plaintext)
      expect(secret.encrypted.startsWith('enc:v1:')).toBe(true)
    })

    /**
     * The prefix is what makes a leaked secret greppable as a Cascadia
     * credential in a log, a config file or a support ticket, rather than
     * indistinguishable from any other hex blob.
     */
    it('marks the plaintext with a greppable prefix', () => {
      const secret = generateWebhookSecret()

      expect(looksLikeWebhookSecret(secret.plaintext)).toBe(true)
      expect(secret.prefix).toHaveLength(12)
      expect(secret.plaintext.startsWith(secret.prefix)).toBe(true)
    })

    it('never stores enough of the secret to sign with', () => {
      const secret = generateWebhookSecret()

      // The display prefix is for identification. If it were long enough to
      // narrow a brute force it would be a partial credential in a column the
      // admin API returns. It is the fixed marker plus a few characters of the
      // random part, and those few are what matter: a quarter of the whole
      // would be 17 random characters, far too many.
      const markerLength = secret.plaintext.length - 64
      const randomCharactersShown = secret.prefix.length - markerLength
      expect(randomCharactersShown).toBeLessThanOrEqual(6)
    })

    it('generates a distinct secret every time', () => {
      const first = generateWebhookSecret()
      const second = generateWebhookSecret()

      expect(first.plaintext).not.toBe(second.plaintext)
      expect(first.encrypted).not.toBe(second.encrypted)
    })
  })

  describe('without ENCRYPTION_KEY', () => {
    beforeEach(() => {
      delete process.env.ENCRYPTION_KEY
    })

    /**
     * This is the deliberate departure from the admin AI-provider route, which
     * stores a provider key in plaintext with a warning. A plaintext provider
     * key leaks a credential the operator already holds elsewhere and can
     * rotate upstream; a plaintext HMAC key lets anyone who can read a table
     * the admin API reads **forge deliveries** into whatever the customer wired
     * the webhook to. Same shape of config gap, different blast radius, so a
     * different answer.
     */
    it('refuses to mint a secret rather than storing one in the clear', () => {
      expect(isEncryptionConfigured()).toBe(false)
      expect(() => generateWebhookSecret()).toThrow(ValidationError)
    })

    it('names the variable the operator has to set', () => {
      let message = ''
      try {
        generateWebhookSecret()
      } catch (error) {
        message = error instanceof Error ? error.message : ''
      }
      expect(message).toContain('ENCRYPTION_KEY')
    })
  })
})
