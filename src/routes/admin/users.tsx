import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  CheckCircle,
  KeyRound,
  Lock,
  Search,
  Users,
} from 'lucide-react'
import { Badge, Button, Card, Input, Label } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'

export const Route = createFileRoute('/admin/users')({
  component: UsersPage,
})

interface UserRole {
  id: string
  name: string
}

interface UserRecord {
  id: string
  name: string | null
  email: string
  active: boolean
  lockedUntil: string | null
  roles: Array<UserRole>
}

function UsersPage() {
  const [users, setUsers] = useState<Array<UserRecord>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  // Reset password dialog state
  const [resetUser, setResetUser] = useState<UserRecord | null>(null)
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [resetLoading, setResetLoading] = useState(false)
  const [resetStatus, setResetStatus] = useState<'idle' | 'success' | 'error'>(
    'idle',
  )
  const [resetError, setResetError] = useState('')

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true)
      const params = new URLSearchParams()
      if (searchQuery) params.set('search', searchQuery)

      const response = await fetch(`/api/users?${params}`)
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to fetch users')
      }

      const data = await response.json()
      setUsers(data.data?.users ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }, [searchQuery])

  useEffect(() => {
    fetchUsers()
  }, [fetchUsers])

  const openResetDialog = (user: UserRecord) => {
    setResetUser(user)
    setNewPassword('')
    setConfirmPassword('')
    setResetStatus('idle')
    setResetError('')
  }

  const closeResetDialog = () => {
    setResetUser(null)
    setNewPassword('')
    setConfirmPassword('')
    setResetStatus('idle')
    setResetError('')
  }

  const handleResetPassword = async () => {
    if (!resetUser) return

    if (newPassword.length < 8) {
      setResetError('Password must be at least 8 characters')
      setResetStatus('error')
      return
    }

    if (newPassword !== confirmPassword) {
      setResetError('Passwords do not match')
      setResetStatus('error')
      return
    }

    setResetLoading(true)
    setResetStatus('idle')

    try {
      const response = await fetch(
        `/api/users/${resetUser.id}/reset-password`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: newPassword }),
        },
      )

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error?.message || 'Failed to reset password')
      }

      setResetStatus('success')
      setTimeout(closeResetDialog, 1500)
    } catch (err) {
      setResetError(err instanceof Error ? err.message : 'An error occurred')
      setResetStatus('error')
    } finally {
      setResetLoading(false)
    }
  }

  const isLocked = (user: UserRecord) =>
    user.lockedUntil && new Date(user.lockedUntil) > new Date()

  if (loading && users.length === 0) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Users size={32} className="text-cyan-600" />
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
          <Users size={32} className="text-cyan-600" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            User Management
          </h1>
        </div>
        <div className="bg-destructive/10 border border-destructive/20 text-destructive px-4 py-3 rounded">
          {error}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Users size={32} className="text-cyan-600" />
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
                      onClick={() => openResetDialog(user)}
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

      {/* Reset Password Dialog */}
      <Dialog
        open={!!resetUser}
        onOpenChange={(open) => !open && closeResetDialog()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
            <DialogDescription>
              Set a new password for{' '}
              <strong>{resetUser?.name || resetUser?.email}</strong>. This will
              sign them out of all active sessions.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="new-password">New Password</Label>
              <Input
                id="new-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Minimum 8 characters"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm Password</Label>
              <Input
                id="confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Re-enter password"
              />
            </div>

            {resetStatus === 'success' && (
              <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
                <CheckCircle className="h-4 w-4" />
                Password reset successfully.
              </div>
            )}
            {resetStatus === 'error' && (
              <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
                <AlertCircle className="h-4 w-4" />
                {resetError}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeResetDialog}>
              Cancel
            </Button>
            <Button
              onClick={handleResetPassword}
              disabled={resetLoading || !newPassword || !confirmPassword}
            >
              {resetLoading ? 'Resetting...' : 'Reset Password'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
