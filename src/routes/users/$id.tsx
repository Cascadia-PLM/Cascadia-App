import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { ArrowLeft, Edit, Key, Shield, Trash2 } from 'lucide-react'
import type { Role } from '@/lib/auth/types'
import { PageContainer } from '@/components/layout'
import { UserForm } from '@/components/users/UserForm'
import { RoleAssignmentDialog } from '@/components/users/RoleAssignmentDialog'
import { PasswordChangeDialog } from '@/components/users/PasswordChangeDialog'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

export const Route = createFileRoute('/users/$id')({
  component: UserDetailPage,
  loader: async ({ params }) => {
    try {
      // Fetch user and roles in parallel
      const [userResult, rolesResult] = await Promise.all([
        apiFetch<{ data: { user: any } }>(`/api/users/${params.id}`),
        apiFetch<{ data: { roles: Array<Role>; total: number } }>('/api/roles'),
      ])

      return {
        user: userResult.data.user,
        roles: rolesResult.data.roles,
      }
    } catch (error) {
      console.error('Error loading user:', error)
      throw error
    }
  },
})

function UserDetailPage() {
  const router = useRouter()
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const { user, roles } = Route.useLoaderData()
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [isRoleDialogOpen, setIsRoleDialogOpen] = useState(false)
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleEdit = async (data: any) => {
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/users/${user.id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      })

      setIsEditDialogOpen(false)
      showSuccess('User updated', `${user.email} has been updated successfully`)
      router.invalidate()
    } catch (error) {
      handleError(error, { title: 'Failed to update user' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDelete = () => {
    confirm({
      title: 'Delete User',
      description: `Are you sure you want to delete ${user.email}? This action cannot be undone.`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/users/${user.id}`, {
            method: 'DELETE',
          })

          showSuccess('User deleted', `${user.email} has been deleted`)
          await router.invalidate()
          router.navigate({ to: '/users' })
        } catch (error) {
          handleError(error, { title: 'Failed to delete user' })
        }
      },
    })
  }

  const handleToggleActive = async () => {
    try {
      await apiFetch(`/api/users/${user.id}/activate`, {
        method: 'POST',
        body: JSON.stringify({ active: !user.active }),
      })

      showSuccess(
        'Status updated',
        `User ${user.active ? 'deactivated' : 'activated'} successfully`,
      )
      router.invalidate()
    } catch (error) {
      handleError(error, { title: 'Failed to toggle user status' })
    }
  }

  const handleAssignRoles = async (userId: string, roleIds: Array<string>) => {
    try {
      await apiFetch(`/api/users/${userId}/roles`, {
        method: 'PUT',
        body: JSON.stringify({ roleIds }),
      })

      showSuccess('Roles updated', 'User roles have been updated successfully')
      router.invalidate()
    } catch (error) {
      handleError(error, { title: 'Failed to assign roles' })
      throw error
    }
  }

  const handleChangePassword = async (userId: string, password: string) => {
    try {
      await apiFetch(`/api/users/${userId}/password`, {
        method: 'PUT',
        body: JSON.stringify({ password }),
      })

      showSuccess('Password changed', 'Password has been changed successfully')
    } catch (error) {
      handleError(error, { title: 'Failed to change password' })
      throw error
    }
  }

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link to="/users">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {user.name || user.email}
              </h1>
              <Badge variant={user.active ? 'success' : 'destructive'}>
                {user.active ? 'Active' : 'Inactive'}
              </Badge>
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-2">
              {user.email}
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setIsEditDialogOpen(true)}>
            <Edit className="h-4 w-4 mr-2" />
            Edit
          </Button>
          <Button variant="outline" onClick={() => setIsRoleDialogOpen(true)}>
            <Shield className="h-4 w-4 mr-2" />
            Manage Roles
          </Button>
          {user.provider === 'local' && (
            <Button
              variant="outline"
              onClick={() => setIsPasswordDialogOpen(true)}
            >
              <Key className="h-4 w-4 mr-2" />
              Change Password
            </Button>
          )}
          <Button variant="outline" onClick={handleToggleActive}>
            {user.active ? 'Deactivate' : 'Activate'}
          </Button>
          <Button variant="outline" onClick={handleDelete}>
            <Trash2 className="h-4 w-4 mr-2 text-red-600" />
            Delete
          </Button>
        </div>
      </div>

      {/* User Information */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Basic Information */}
        <Card>
          <CardHeader>
            <CardTitle>Basic Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-500">
                Email
              </label>
              <p className="text-slate-900 dark:text-white">{user.email}</p>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-500">Name</label>
              <p className="text-slate-900 dark:text-white">
                {user.name || '-'}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-500">
                Provider
              </label>
              <p>
                <Badge variant="secondary">{user.provider || 'local'}</Badge>
              </p>
            </div>
            {user.providerId && (
              <div>
                <label className="text-sm font-medium text-slate-500">
                  Provider ID
                </label>
                <p className="text-slate-900 dark:text-white text-sm font-mono">
                  {user.providerId}
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Account Status */}
        <Card>
          <CardHeader>
            <CardTitle>Account Status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <label className="text-sm font-medium text-slate-500">
                Status
              </label>
              <p>
                <Badge variant={user.active ? 'success' : 'destructive'}>
                  {user.active ? 'Active' : 'Inactive'}
                </Badge>
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-500">
                Last Login
              </label>
              <p className="text-slate-900 dark:text-white">
                {user.lastLogin
                  ? new Date(user.lastLogin).toLocaleString()
                  : 'Never'}
              </p>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-500">
                Created At
              </label>
              <p className="text-slate-900 dark:text-white">
                {new Date(user.createdAt).toLocaleString()}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Roles and Permissions */}
      <Card>
        <CardHeader>
          <CardTitle>Roles and Permissions</CardTitle>
          <CardDescription>
            Roles assigned to this user and their associated permissions
          </CardDescription>
        </CardHeader>
        <CardContent>
          {user.roles.length > 0 ? (
            <div className="space-y-6">
              {user.roles.map((role) => (
                <div key={role.id} className="border-b pb-6 last:border-b-0">
                  <div className="flex items-start justify-between mb-3">
                    <div>
                      <h3 className="font-semibold text-lg">{role.name}</h3>
                      {role.description && (
                        <p className="text-sm text-slate-500 mt-1">
                          {role.description}
                        </p>
                      )}
                    </div>
                  </div>
                  {role.permissions && (
                    <div className="mt-3">
                      <label className="text-sm font-medium text-slate-500">
                        Permissions
                      </label>
                      <div className="mt-2 space-y-2">
                        {Object.entries(role.permissions).map(
                          ([resource, actions]) => (
                            <div
                              key={resource}
                              className="flex gap-2 items-center"
                            >
                              <span className="text-sm font-medium min-w-[120px]">
                                {resource}:
                              </span>
                              <div className="flex gap-1 flex-wrap">
                                {actions.map((action) => (
                                  <Badge
                                    key={action}
                                    variant="secondary"
                                    className="text-xs"
                                  >
                                    {action}
                                  </Badge>
                                ))}
                              </div>
                            </div>
                          ),
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-slate-500">No roles assigned to this user</p>
          )}
        </CardContent>
      </Card>

      {/* Edit User Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update the user details below.
            </DialogDescription>
          </DialogHeader>
          <UserForm
            mode="edit"
            user={{
              email: user.email,
              name: user.name ?? undefined,
              provider: user.provider ?? undefined,
              providerId: user.providerId ?? undefined,
              active: user.active,
            }}
            onSubmit={handleEdit}
            onCancel={() => setIsEditDialogOpen(false)}
            isSubmitting={isSubmitting}
          />
        </DialogContent>
      </Dialog>

      {/* Role Assignment Dialog */}
      <RoleAssignmentDialog
        user={user}
        roles={roles}
        open={isRoleDialogOpen}
        onClose={() => setIsRoleDialogOpen(false)}
        onSave={handleAssignRoles}
      />

      {/* Password Change Dialog */}
      <PasswordChangeDialog
        user={user}
        open={isPasswordDialogOpen}
        onClose={() => setIsPasswordDialogOpen(false)}
        onSave={handleChangePassword}
      />
    </PageContainer>
  )
}
