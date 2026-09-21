// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * OAuth Provider Configuration
 *
 * Initializes OAuth clients for supported providers using Arctic.
 * Supports GitHub and Google; Azure can be added following the same pattern.
 */

import { GitHub, Google } from 'arctic'

let _githubProvider: GitHub | null = null
let _googleProvider: Google | null = null

/**
 * Get the GitHub OAuth provider instance.
 * Throws if GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET are not configured.
 */
export function getGitHubProvider(): GitHub {
  if (_githubProvider) return _githubProvider

  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
  // Must match where the auth module is actually mounted (`/api/v1/auth` in
  // `server/index.ts`): GitHub validates this against the app's registered
  // callback URL at the authorize hop and again at the token exchange.
  const redirectURI = `${baseUrl}/api/v1/auth/callback/github`

  if (!clientId || !clientSecret) {
    throw new Error(
      'GitHub OAuth not configured. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET environment variables.',
    )
  }

  _githubProvider = new GitHub(clientId, clientSecret, redirectURI)
  return _githubProvider
}

/**
 * Check if GitHub OAuth is configured (env vars present).
 */
export function isGitHubOAuthConfigured(): boolean {
  return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET)
}

/**
 * Google Workspace domains permitted to sign in, or empty for no restriction.
 *
 * Read from GOOGLE_ALLOWED_DOMAINS as a comma-separated list, and matched
 * against the `hd` claim of the id token — the domain Google itself asserts
 * the account belongs to. A list rather than a single value because Workspace
 * accounts frequently carry alias domains, and what matters is the domain
 * Google actually returns at sign-in.
 */
export function getAllowedGoogleDomains(): Array<string> {
  return (process.env.GOOGLE_ALLOWED_DOMAINS || '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
}

/**
 * Whether a Google account may sign in, given the `hd` claim of its id token.
 *
 * With no domains configured every account is admitted — the same posture as
 * GitHub, where any account with a verified email may sign in and is
 * provisioned on first sight. With a list, only accounts whose `hd` is on it
 * are admitted.
 *
 * `hd` is checked rather than the email's domain because `hd` is what Google
 * asserts about which Workspace the account belongs to. The email domain is
 * weaker: consumer accounts can carry a vanity address at any domain, and would
 * otherwise pass. A missing `hd` means a personal Google account, which a
 * restricted deployment rejects.
 */
export function isGoogleAccountPermitted(
  hd: string | undefined,
  allowedDomains: Array<string> = getAllowedGoogleDomains(),
): boolean {
  if (allowedDomains.length === 0) return true
  if (!hd) return false
  return allowedDomains.includes(hd.toLowerCase())
}

let _unrestrictedWarned = false

/**
 * Get the Google OAuth provider instance.
 * Throws if the provider is not configured.
 */
export function getGoogleProvider(): Google {
  if (_googleProvider) return _googleProvider

  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
  const redirectURI = `${baseUrl}/api/v1/auth/callback/google`

  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.',
    )
  }

  // Said once, at the first sign-in attempt rather than at boot, so it lands
  // next to the request it describes. A self-hosted deployment that meant to
  // restrict sign-in and lost the variable would otherwise open up silently.
  if (!_unrestrictedWarned && getAllowedGoogleDomains().length === 0) {
    _unrestrictedWarned = true
    console.warn(
      'Google sign-in is open to any Google account. Set GOOGLE_ALLOWED_DOMAINS to restrict it to your Workspace domains.',
    )
  }

  _googleProvider = new Google(clientId, clientSecret, redirectURI)
  return _googleProvider
}

/**
 * Check if Google OAuth is configured.
 *
 * GOOGLE_ALLOWED_DOMAINS is not part of this: it narrows who may sign in, and
 * leaving it unset is a valid choice, not a half-configured one.
 */
export function isGoogleOAuthConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
}
