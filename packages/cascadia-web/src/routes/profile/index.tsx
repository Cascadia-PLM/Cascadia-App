// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { useState } from 'react'
import { KeyRound, LockKeyhole, Mail, User } from 'lucide-react'
import type { FormEvent } from 'react'
import { PageContainer } from '@/components/layout'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { authSessionQuery } from '@/lib/query'

export const Route = createFileRoute('/profile/')({
  component: ProfilePage,
  beforeLoad: async ({ context }) => {
    // Read the session through the shared cache the root route already
    // primed, rather than firing a second /auth/session for this page.
    const session = await context.queryClient.fetchQuery(authSessionQuery())
    if (!session.authenticated || !session.user) {
      throw redirect({ to: '/login' })
    }
    return { user: session.user }
  },
})

function ProfilePage() {
  const { user } = Route.useRouteContext()

  // Generate initials from name or email
  const getInitials = () => {
    if (user.name) {
      return user.name
        .split(' ')
        .map((n: string) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    }
    return user.email[0].toUpperCase()
  }

  return (
    <PageContainer maxWidth="wide">
      {/* Header */}
      <div>
        <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
          Profile
        </h1>
        <p className="text-slate-600 dark:text-slate-400 mt-2">
          Manage your account information
        </p>
      </div>

      {/* Profile Card */}
      <Card>
        <CardHeader>
          <CardTitle>Account Information</CardTitle>
          <CardDescription>Your personal details</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Avatar */}
          <div className="flex items-center gap-4">
            <div className="flex items-center justify-center w-20 h-20 rounded-full bg-cyan-600 dark:bg-cyan-500 text-white font-bold text-2xl">
              {getInitials()}
            </div>
            <div>
              <h3 className="text-lg font-semibold text-slate-900 dark:text-white">
                {user.name || 'User'}
              </h3>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                {user.email}
              </p>
            </div>
          </div>

          {/* User Details */}
          <div className="space-y-4 pt-6 border-t border-slate-300 dark:border-slate-700">
            <div className="flex items-start gap-3">
              <User className="w-5 h-5 text-slate-400 mt-0.5" />
              <div className="flex-1">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Name
                </label>
                <p className="text-slate-900 dark:text-white">
                  {user.name || 'Not set'}
                </p>
              </div>
            </div>

            <div className="flex items-start gap-3">
              <Mail className="w-5 h-5 text-slate-400 mt-0.5" />
              <div className="flex-1">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Email
                </label>
                <p className="text-slate-900 dark:text-white">{user.email}</p>
              </div>
            </div>
          </div>

          {/* Coming Soon Notice */}
          <div className="pt-6 border-t border-slate-300 dark:border-slate-700">
            <p className="text-sm text-slate-600 dark:text-slate-400 text-center py-4">
              Profile detail editing and additional settings coming soon
            </p>
          </div>
        </CardContent>
      </Card>

      <PasswordChangeCard />

      {/* API Keys */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>API Keys</CardTitle>
          </div>
          <CardDescription>
            Credentials for headless clients that act as you
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Issue keys for CI jobs, CAD connectors, and MCP; scope each one to
              the permissions and roles its client actually needs, and review
              where it has been used.
            </p>
            <Link to="/profile/api-keys">
              <Button>
                <KeyRound className="w-4 h-4 mr-2" />
                Manage API Keys
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    </PageContainer>
  )
}

function PasswordChangeCard() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setSuccess(null)

    if (password.length < 8) {
      setError('New password must be at least 8 characters')
      return
    }

    if (password.length > 128) {
      setError('New password must not exceed 128 characters')
      return
    }

    if (password !== confirmPassword) {
      setError('New passwords do not match')
      return
    }

    setIsSubmitting(true)
    try {
      await apiFetch('/api/v1/auth/password', {
        method: 'PUT',
        body: JSON.stringify({ currentPassword, password }),
        retry: false,
      })

      setCurrentPassword('')
      setPassword('')
      setConfirmPassword('')
      setSuccess('Password changed. Your other sessions have been signed out.')
    } catch (changeError) {
      setError(
        changeError instanceof Error
          ? changeError.message
          : 'Failed to change password',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <LockKeyhole className="w-5 h-5 text-slate-600 dark:text-slate-400" />
          <CardTitle>Change Password</CardTitle>
        </div>
        <CardDescription>
          Verify your current password before choosing a new one
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4 max-w-md">
          <div className="space-y-2">
            <Label htmlFor="current-password">Current Password</Label>
            <Input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              autoComplete="current-password"
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="new-password">New Password</Label>
            <Input
              id="new-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              8 to 128 characters
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-new-password">Confirm New Password</Label>
            <Input
              id="confirm-new-password"
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
              required
            />
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          {success && (
            <p className="text-sm text-green-600 dark:text-green-400">
              {success}
            </p>
          )}

          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Changing...' : 'Change Password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}
