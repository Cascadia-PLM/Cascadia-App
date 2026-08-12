// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { KeyRound, Mail, User } from 'lucide-react'
import { PageContainer } from '@/components/layout'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

export const Route = createFileRoute('/profile/')({
  component: ProfilePage,
  beforeLoad: async () => {
    // Check if user is authenticated
    try {
      const response = await fetch('/api/v1/auth/session')
      const data = await response.json()
      if (!data.data?.authenticated) {
        throw redirect({
          to: '/login',
        })
      }
      return { user: data.data.user }
    } catch (error) {
      throw redirect({
        to: '/login',
      })
    }
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
              Profile editing and additional settings coming soon
            </p>
          </div>
        </CardContent>
      </Card>

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
