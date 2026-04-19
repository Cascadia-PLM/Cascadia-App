import { hash as argon2Hash, verify as argon2Verify } from '@node-rs/argon2'
import { SHA256 } from '@oslojs/crypto/sha2'
import { decodeBase64, encodeBase64 } from '@oslojs/encoding'
import { authLogger } from '@/lib/logging/logger'

const ARGON2_PREFIX = 'argon2id:'

/**
 * Hash a password using Argon2id (current standard).
 */
export async function hashPassword(password: string): Promise<string> {
  const hashed = await argon2Hash(password, {
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  })
  return `${ARGON2_PREFIX}${hashed}`
}

/**
 * Verify a password against a stored hash.
 * Supports both Argon2id (new) and PBKDF2 (legacy) formats.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  if (storedHash.startsWith(ARGON2_PREFIX)) {
    try {
      return await argon2Verify(
        storedHash.slice(ARGON2_PREFIX.length),
        password,
      )
    } catch (error) {
      authLogger.error({ err: error }, 'Argon2 password verification error')
      return false
    }
  }

  // Legacy PBKDF2 format
  return verifyPasswordPbkdf2(storedHash, password)
}

/**
 * Check if a stored hash needs to be rehashed (i.e., uses legacy PBKDF2).
 */
export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith(ARGON2_PREFIX)
}

/**
 * Legacy PBKDF2 password verification for gradual migration.
 */
async function verifyPasswordPbkdf2(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    const combined = decodeBase64(hash)

    // Extract salt and hash
    const salt = combined.slice(0, 16)
    const originalHash = combined.slice(16)

    const encoder = new TextEncoder()
    const data = encoder.encode(password)

    // Import key for PBKDF2
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      data,
      'PBKDF2',
      false,
      ['deriveBits'],
    )

    // Derive key using same parameters
    const derivedBits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: salt,
        iterations: 100000,
        hash: 'SHA-256',
      },
      keyMaterial,
      256,
    )

    const newHash = new Uint8Array(derivedBits)

    // Constant-time comparison
    if (newHash.length !== originalHash.length) {
      return false
    }

    let result = 0
    for (let i = 0; i < newHash.length; i++) {
      result |= newHash[i] ^ originalHash[i]
    }

    return result === 0
  } catch (error) {
    authLogger.error({ err: error }, 'PBKDF2 password verification error')
    return false
  }
}

/**
 * Generate a random session token
 */
export function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return encodeBase64(bytes)
}

/**
 * Hash a session token for storage
 */
export function hashSessionToken(token: string): string {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hasher = new SHA256()
  hasher.update(data)
  const hash = hasher.digest()
  return encodeBase64(hash)
}
