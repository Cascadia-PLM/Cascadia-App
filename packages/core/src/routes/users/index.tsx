// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Plus } from 'lucide-react'
import type { UserWithRoles } from '@/lib/auth/types'
import { PageContainer } from '@/components/layout'
import { UserTable } from '@/components/users/UserTable'
import { RoleAssignmentDialog } from '@/components/users/RoleAssignmentDialog'
import { PasswordChangeDialog } from '@/components/users/PasswordChangeDialog'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import {
  roleListQuery,
  useInvalidateResources,
  userListQuery,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/users/')({
  component: UsersListPage,
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      queryClient.ensureQueryData(userListQuery()),
      queryClient.ensureQueryData(roleListQuery()),
    ])
  },
})

function UsersListPage() {
  const { alert, confirm } = useAlertDialog()
  const invalidate = useInvalidateResources()
  const { data: users = [] } = useQuery(userListQuery())
  const { data: roles = [] } = useQuery(roleListQuery())
  const [isRoleDialogOpen, setIsRoleDialogOpen] = useState(false)
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<UserWithRoles | null>(null)

  const stats = useMemo(() => {
    const byProvider: Record<string, number> = {}
    for (const user of users) {
      const provider = user.provider ?? 'local'
      byProvider[provider] = (byProvider[provider] ?? 0) + 1
    }
    const active = users.filter((u) => u.active).length
    return {
      total: users.length,
      active,
      inactive: users.length - active,
      byProvider,
    }
  }, [users])

  // Navigate to detail page for editing (if it exists) or show alert
  const handleEditUser = (_user: UserWithRoles) => {
    // For now, users are edited via the list page dialogs
    // This could navigate to /users/$id if a detail page is created
    alert({
      title: 'Edit User',
      description:
        'To edit user details, use the role assignment or password change options from the table actions.',
    })
  }

  const handleDeleteUser = (user: UserWithRoles) => {
    if (!user.id) return

    confirm({
      title: 'Delete User',
      description: `Are you sure you want to delete ${user.email}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/users/${user.id}`, {
            method: 'DELETE',
          })

          await invalidate('users')
        } catch (error) {
          console.error('Error deleting user:', error)
          alert({
            title: 'Error',
            description: 'Failed to delete user',
            variant: 'destructive',
          })
        }
      },
    })
  }

  const handleAssignRoles = async (userId: string, roleIds: Array<string>) => {
    try {
      await apiFetch(`/api/v1/users/${userId}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleIds }),
      })

      await invalidate('users', 'roles')
    } catch (error) {
      console.error('Error assigning roles:', error)
      throw error
    }
  }

  const handleChangePassword = async (userId: string, password: string) => {
    try {
      await apiFetch(`/api/v1/users/${userId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password }),
      })
    } catch (error) {
      console.error('Error changing password:', error)
      throw error
    }
  }

  const openRoleDialog = (user: UserWithRoles) => {
    setEditingUser(user)
    setIsRoleDialogOpen(true)
  }

  const openPasswordDialog = (user: UserWithRoles) => {
    setEditingUser(user)
    setIsPasswordDialogOpen(true)
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
            Users
          </h1>
          <p className="text-slate-600 dark:text-slate-400 mt-2">
            Manage user accounts and permissions
          </p>
        </div>
        <Link to="/users/new">
          <Button>
            <Plus className="h-4 w-4 mr-2" />
            Create User
          </Button>
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Total Users</CardDescription>
            <CardTitle className="text-3xl">{stats.total}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Active</CardDescription>
            <CardTitle className="text-3xl text-green-600 dark:text-green-400">
              {stats.active}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Inactive</CardDescription>
            <CardTitle className="text-3xl text-red-600 dark:text-red-400">
              {stats.inactive}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Providers</CardDescription>
            <CardTitle className="text-3xl">
              {Object.keys(stats.byProvider).length}
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Users Table */}
      <Card>
        <CardHeader>
          <CardTitle>All Users</CardTitle>
          <CardDescription>
            {users.length} {users.length === 1 ? 'user' : 'users'} in the system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <UserTable
            users={users}
            onEdit={handleEditUser}
            onDelete={handleDeleteUser}
            onManageRoles={openRoleDialog}
            onChangePassword={openPasswordDialog}
          />
        </CardContent>
      </Card>

      {/* Role Assignment Dialog */}
      <RoleAssignmentDialog
        user={editingUser}
        roles={roles}
        open={isRoleDialogOpen}
        onClose={() => {
          setIsRoleDialogOpen(false)
          setEditingUser(null)
        }}
        onSave={handleAssignRoles}
      />

      {/* Password Change Dialog */}
      <PasswordChangeDialog
        user={editingUser}
        open={isPasswordDialogOpen}
        onClose={() => {
          setIsPasswordDialogOpen(false)
          setEditingUser(null)
        }}
        onSave={handleChangePassword}
      />
    </PageContainer>
  )
}
