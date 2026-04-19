import {
  ClientOnly,
  createFileRoute,
  useNavigate,
} from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'
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
  no_email: 'Your GitHub account must have a verified email address.',
  oauth_failed: 'OAuth authentication failed. Please try again.',
}

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const navigate = useNavigate()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [oauthLoading, setOauthLoading] = useState(false)
  const gearBackgroundRef = useRef<AnimatedGearBackgroundRef>(null)

  // Show OAuth errors from callback redirects
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const oauthError = params.get('error')
    if (oauthError) {
      const message =
        params.get('message') ||
        OAUTH_ERROR_MESSAGES[oauthError] ||
        'Authentication failed. Please try again.'
      setError(message)
      // Clean up URL
      window.history.replaceState({}, '', '/login')
    }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setIsLoading(true)

    try {
      const response = await fetch('/api/auth/login', {
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

        {/* OAuth divider */}
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

        {/* GitHub OAuth */}
        <Button
          type="button"
          variant="outline"
          className="w-full flex items-center justify-center gap-2"
          disabled={oauthLoading || isLoading}
          onClick={() => {
            setOauthLoading(true)
            window.location.href = '/api/auth/github'
          }}
          data-testid="login-github"
        >
          {oauthLoading ? (
            <LoadingSpinner size="sm" />
          ) : (
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z" />
            </svg>
          )}
          Sign in with GitHub
        </Button>
      </Card>
    </div>
  )
}
