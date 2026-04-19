import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Plus } from 'lucide-react'
import type { Role, UserWithRoles } from '@/lib/auth/types'
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
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/users/')({
  component: UsersListPage,
  loader: async () => {
    try {
      // Fetch users and roles in parallel
      const [usersResult, rolesResult] = await Promise.all([
        apiFetch<{
          data: {
            users: Array<UserWithRoles>
            stats: {
              total: number
              active: number
              inactive: number
              byProvider: Record<string, number>
            }
          }
        }>('/api/users'),
        apiFetch<{ data: { roles: Array<Role>; total: number } }>('/api/roles'),
      ])

      return {
        users: usersResult.data.users,
        roles: rolesResult.data.roles,
        stats: usersResult.data.stats,
      }
    } catch (error) {
      console.error('Error loading users:', error)
      return {
        users: [] as Array<UserWithRoles>,
        roles: [] as Array<Role>,
        stats: { total: 0, active: 0, inactive: 0, byProvider: {} },
      }
    }
  },
})

function UsersListPage() {
  const router = useRouter()
  const { alert, confirm } = useAlertDialog()
  const {
    users: initialUsers,
    roles,
    stats: initialStats,
  } = Route.useLoaderData()
  const [users, setUsers] = useState<Array<UserWithRoles>>(initialUsers)
  const [stats, setStats] = useState(initialStats)
  const [isRoleDialogOpen, setIsRoleDialogOpen] = useState(false)
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false)
  const [editingUser, setEditingUser] = useState<UserWithRoles | null>(null)

  // Sync local state with loader data when it changes
  useEffect(() => {
    setUsers(initialUsers)
    setStats(initialStats)
  }, [initialUsers, initialStats])

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
          const response = await fetch(`/api/users/${user.id}`, {
            method: 'DELETE',
          })

          if (!response.ok) {
            throw new Error('Failed to delete user')
          }

          // Reload to get fresh data from server
          router.invalidate()
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
      const response = await fetch(`/api/users/${userId}/roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleIds }),
      })

      if (!response.ok) {
        throw new Error('Failed to assign roles')
      }

      // Reload to get fresh data from server
      router.invalidate()
    } catch (error) {
      console.error('Error assigning roles:', error)
      throw error
    }
  }

  const handleChangePassword = async (userId: string, password: string) => {
    try {
      const response = await fetch(`/api/users/${userId}/password`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })

      if (!response.ok) {
        throw new Error('Failed to change password')
      }
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
            <CardTitle className="text-3xl text-green-600">
              {stats.active}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-3">
            <CardDescription>Inactive</CardDescription>
            <CardTitle className="text-3xl text-red-600">
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
