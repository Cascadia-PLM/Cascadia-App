// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  ClientOnly,
  createFileRoute,
  useNavigate,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { invalidateEverything } from '../lib/query'
import { authProvidersQuery } from '../lib/query/options/auth'
import { Button } from '../components/ui/Button'
import { Input } from '../components/ui/Input'
import { Label } from '../components/ui/Label'
import { Card } from '../components/ui/Card'
import { LoadingSpinner } from '../components/ui/LoadingSpinner'
import { AnimatedGearBackground } from '../components/AnimatedGearBackground'
import type { AnimatedGearBackgroundRef } from '../components/AnimatedGearBackground'
import cascadiaLogo from '/cascadia-plm-logo-icon.svg'

const OAUTH_ERROR_MESSAGES: Record<string, string> = {
  missing_params: 'OAuth callback missing required parameters.',
  invalid_state: 'OAuth state validation failed. Please try again.',
  github_api_error: 'Failed to communicate with GitHub.',
  google_api_error: 'Failed to communicate with Google.',
  no_email: 'Your GitHub account must have a verified email address.',
  email_unverified: 'Your email address is not verified with the provider.',
  wrong_domain:
    'That account is not part of an organisation permitted to sign in here. Use your work Google account.',
  account_inactive:
    'Your account has been deactivated. Contact an administrator.',
  oauth_failed: 'OAuth authentication failed. Please try again.',
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState<string | null>(null)
  const gearBackgroundRef = useRef<AnimatedGearBackgroundRef>(null)

  // Only offer the providers the server actually has credentials for; both
  // buttons stay hidden until the answer arrives.
  const { data: providers = { github: false, google: false } } =
    useQuery(authProvidersQuery())

  // Show OAuth errors from callback redirects, and prefill the email when a
  // link carries one (the hosted demo's "open my demo" flow lands here with
  // `?email=`). Either way the query string is scrubbed so a reload or a
  // bookmark does not keep replaying it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthError = params.get('error')
    const prefillEmail = params.get('email')
    if (prefillEmail) {
      setUsername(prefillEmail)
    }
    if (oauthError) {
      const message =
        params.get('message') ||
        OAUTH_ERROR_MESSAGES[oauthError] ||
        'Authentication failed. Please try again.'
      setError(message)
    }
    if (oauthError || prefillEmail) {
      // Clean up URL
      window.history.replaceState({}, '', '/login')
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const response = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      })

      const data = await response.json()

      if (!response.ok) {
        // API returns { error: { code, message, ... } }
        const errorMessage =
          data.error?.message || data.message || 'Login failed'
        setError(errorMessage)
        setIsLoading(false)
        return
      }

      // Signing in changes identity, so nothing cached for the signed-out
      // session may survive. The root route's `beforeLoad` resolves the
      // session through `ensureQueryData`, which hands back a cached entry
      // even once it is stale — leave the `{ authenticated: false }` entry
      // in place and the navigate below is redirected right back here.
      invalidateEverything(queryClient)

      // Trigger gear speed-up animation
      gearBackgroundRef.current?.speedUp()

      // Store session token in cookie (handled by server)
      // Brief delay to show the speed-up animation before redirect
      setTimeout(() => {
        navigate({ to: '/' })
      }, 800)
    } catch (err) {
      setError('An error occurred. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 relative">
      {/* Animated gear background - only render on client to avoid hydration mismatch */}
      <ClientOnly
        fallback={
          <div className="fixed inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900" />
        }
      >
        <AnimatedGearBackground ref={gearBackgroundRef} />
      </ClientOnly>

      {/* Login card - positioned above background */}
      <Card className="w-full max-w-md p-8 relative z-10 bg-white/95 dark:bg-gray-900/95 backdrop-blur-sm shadow-2xl">
        <div className="mb-8 text-center">
          <div className="flex justify-center mb-4">
            <img src={cascadiaLogo} alt="Cascadia PLM" className="h-16 w-16" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2">
            Cascadia PLM
          </h1>
          <p className="text-gray-600 dark:text-gray-400">
            Sign in to your account
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-6"
          data-testid="login-form"
        >
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Enter your username"
              required
              autoComplete="username"
              autoFocus
              data-testid="login-username"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              autoComplete="current-password"
              data-testid="login-password"
            />
          </div>

          {error && (
            <div
              className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded"
              data-testid="login-error"
            >
              {error}
            </div>
          )}

          <Button
            type="submit"
            className="w-full"
            disabled={isLoading}
            data-testid="login-submit"
          >
            {isLoading ? (
              <span className="flex items-center gap-2">
                <LoadingSpinner size="sm" />
                Signing in...
              </span>
            ) : (
              'Sign in'
            )}
          </Button>
        </form>

        {/* OAuth divider — hidden entirely when no provider is configured */}
        {(providers.google || providers.github) && (
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-gray-300 dark:border-gray-600" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="bg-white dark:bg-gray-900 px-2 text-gray-500 dark:text-gray-400">
                Or continue with
              </span>
            </div>
          </div>
        )}

        {/* Google OAuth */}
        {providers.google && (
          <Button
            type="button"
            variant="outline"
            className="w-full flex items-center justify-center gap-2"
            disabled={!!oauthLoading || isLoading}
            onClick={() => {
              setOauthLoading('google')
              window.location.href = '/api/v1/auth/google'
            }}
            data-testid="login-google"
          >
            {oauthLoading === 'google' ? (
              <LoadingSpinner size="sm" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M23.52 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.46a5.52 5.52 0 01-2.4 3.62v3.01h3.88c2.27-2.09 3.58-5.17 3.58-8.82z"
                />
                <path
                  fill="#34A853"
                  d="M12 24c3.24 0 5.96-1.08 7.94-2.91l-3.88-3.01c-1.08.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.29v3.11A11.995 11.995 0 0012 24z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.29 14.28a7.2 7.2 0 010-4.56V6.61H1.29a12.01 12.01 0 000 10.78l4-3.11z"
                />
                <path
                  fill="#EA4335"
                  d="M12 4.75c1.76 0 3.34.61 4.59 1.8l3.44-3.44C17.95 1.19 15.23 0 12 0 7.31 0 3.26 2.69 1.29 6.61l4 3.11C6.23 6.86 8.88 4.75 12 4.75z"
                />
              </svg>
            )}
            Sign in with Google
          </Button>
        )}

        {/* GitHub OAuth */}
        {providers.github && (
          <Button
            type="button"
            variant="outline"
            className="w-full flex items-center justify-center gap-2 mt-3"
            disabled={!!oauthLoading || isLoading}
            onClick={() => {
              setOauthLoading('github')
              window.location.href = '/api/v1/auth/github'
            }}
            data-testid="login-github"
          >
            {oauthLoading === 'github' ? (
              <LoadingSpinner size="sm" />
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
              </svg>
            )}
            Sign in with GitHub
          </Button>
        )}
      </Card>
    </div>
  )
}
