// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { createFileRoute } from '@tanstack/react-router'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { KeyRound, Lock, Search, Users } from 'lucide-react'
import type { AdminUser } from '@/lib/query'
import { Badge, Button, Card, Input } from '@/components/ui'
import { PasswordResetDialog } from '@/components/users/PasswordResetDialog'
import { adminUserListQuery, useInvalidateResources } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/admin/users')({
  component: UsersPage,
  loader: ({ context: { queryClient } }) =>
    queryClient.ensureQueryData(adminUserListQuery()),
})

function UsersPage() {
  const invalidate = useInvalidateResources()
  const [searchQuery, setSearchQuery] = useState('')
  const {
    data: users = [],
    isPending,
    error,
  } = useQuery({
    ...adminUserListQuery(searchQuery),
    // Keep the current rows on screen while a new search resolves
    placeholderData: keepPreviousData,
  })

  const [resetUser, setResetUser] = useState<AdminUser | null>(null)

  const handleResetPassword = async (userId: string, password: string) => {
    await apiFetch(`/api/v1/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    })

    await invalidate('users')
  }

  const isLocked = (user: AdminUser) =>
    user.lockedUntil && new Date(user.lockedUntil) > new Date()

  if (isPending) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Users size={32} className="text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            User Management
          </h1>
        </div>
        <p className="text-muted-foreground">Loading users...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Users size={32} className="text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            User Management
          </h1>
        </div>
        <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded">
          {error.message}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Users size={32} className="text-cyan-600 dark:text-cyan-400" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            User Management
          </h1>
        </div>
        <Badge variant="secondary">
          {users.length} {users.length === 1 ? 'User' : 'Users'}
        </Badge>
      </div>

      {/* Search */}
      <div className="mb-6 max-w-sm">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Users table */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="text-left p-4 font-medium text-slate-600 dark:text-slate-400">
                  Name
                </th>
                <th className="text-left p-4 font-medium text-slate-600 dark:text-slate-400">
                  Email
                </th>
                <th className="text-left p-4 font-medium text-slate-600 dark:text-slate-400">
                  Status
                </th>
                <th className="text-left p-4 font-medium text-slate-600 dark:text-slate-400">
                  Roles
                </th>
                <th className="text-right p-4 font-medium text-slate-600 dark:text-slate-400">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {users.map((user) => (
                <tr
                  key={user.id}
                  className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="p-4 font-medium text-slate-900 dark:text-white">
                    {user.name || '(no name)'}
                  </td>
                  <td className="p-4 text-slate-600 dark:text-slate-400">
                    {user.email}
                  </td>
                  <td className="p-4">
                    {isLocked(user) ? (
                      <Badge variant="destructive" className="gap-1">
                        <Lock className="h-3 w-3" />
                        Locked
                      </Badge>
                    ) : user.active ? (
                      <Badge
                        variant="secondary"
                        className="bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400"
                      >
                        Active
                      </Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </td>
                  <td className="p-4">
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((role) => (
                        <Badge
                          key={role.id}
                          variant="outline"
                          className="text-xs"
                        >
                          {role.name}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="p-4 text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setResetUser(user)}
                    >
                      <KeyRound className="h-3.5 w-3.5 mr-1.5" />
                      Reset Password
                    </Button>
                  </td>
                </tr>
              ))}
              {users.length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="p-8 text-center text-muted-foreground"
                  >
                    No users found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <PasswordResetDialog
        user={resetUser}
        open={resetUser !== null}
        onClose={() => setResetUser(null)}
        onSave={handleResetPassword}
      />
    </div>
  )
}
