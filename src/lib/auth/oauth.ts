/**
 * OAuth Provider Configuration
 *
 * Initializes OAuth clients for supported providers using Arctic.
 * Currently supports GitHub; Azure and Google can be added following the same pattern.
 */

import { GitHub } from 'arctic'

let _githubProvider: GitHub | null = null

/**
 * Get the GitHub OAuth provider instance.
 * Throws if GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET are not configured.
 */
export function getGitHubProvider(): GitHub {
  if (_githubProvider) return _githubProvider

  const clientId = process.env.GITHUB_CLIENT_ID
  const clientSecret = process.env.GITHUB_CLIENT_SECRET
  const baseUrl = process.env.BASE_URL || 'http://localhost:3000'
  const redirectURI = `${baseUrl}/api/auth/callback/github`

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
