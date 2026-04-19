/**
 * Secure random generation utilities for deployment secrets
 */

import crypto from 'node:crypto'

/**
 * Generate a cryptographically secure random hex string
 * Default 32 bytes = 64 hex characters (256 bits of entropy)
 */
export function generateSecureSecret(bytes: number = 32): string {
  return crypto.randomBytes(bytes).toString('hex')
}

/**
 * Generate a strong password with alphanumeric characters
 * Avoids special characters that might cause issues in env vars or connection strings
 */
export function generatePassword(length: number = 16): string {
  const charset =
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  const randomBytes = crypto.randomBytes(length)
  let password = ''
  for (let i = 0; i < length; i++) {
    password += charset[randomBytes[i] % charset.length]
  }
  return password
}

/**
 * Mask a secret for display, showing only first and last few characters
 */
export function maskSecret(secret: string, visibleChars: number = 4): string {
  if (secret.length <= visibleChars * 2) {
    return '*'.repeat(secret.length)
  }
  const start = secret.slice(0, visibleChars)
  const end = secret.slice(-visibleChars)
  return `${start}...${end}`
}
