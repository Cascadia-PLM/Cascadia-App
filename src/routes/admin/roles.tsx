import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { Shield, Users } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'

export const Route = createFileRoute('/admin/roles')({
  component: RolesPage,
})

interface Role {
  id: string
  name: string
  description: string | null
  permissions: Record<string, Array<string>> | null
}

function RolesPage() {
  const [roles, setRoles] = useState<Array<Role>>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchRoles()
  }, [])

  const fetchRoles = async () => {
    try {
      const response = await fetch('/api/roles')

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to fetch roles')
      }

      const data = await response.json()
      setRoles(data.data?.roles ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred')
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Shield size={32} className="text-cyan-600" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Role Management
          </h1>
        </div>
        <p className="text-muted-foreground">Loading roles...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-900 p-6">
        <div className="flex items-center gap-2 mb-6">
          <Shield size={32} className="text-cyan-600" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Role Management
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
          <Shield size={32} className="text-cyan-600" />
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">
            Role Management
          </h1>
        </div>
        <Badge variant="secondary">
          {roles.length} {roles.length === 1 ? 'Role' : 'Roles'}
        </Badge>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {roles.map((role) => (
          <Card key={role.id} className="p-6">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-xl font-semibold mb-2">{role.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {role.description || 'No description'}
                </p>
              </div>
              <Users size={20} className="text-muted-foreground" />
            </div>

            <div className="space-y-3">
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">
                  Permissions:
                </h4>
                <div className="space-y-2">
                  {role.permissions ? (
                    Object.entries(role.permissions).map(
                      ([resource, actions]) => (
                        <div key={resource} className="text-sm">
                          <span className="font-medium text-foreground capitalize">
                            {resource.replace('_', ' ')}:
                          </span>
                          <div className="flex flex-wrap gap-1 mt-1">
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
                    )
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      No permissions defined
                    </p>
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="mt-8 p-4 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded">
        <h3 className="font-semibold text-slate-900 dark:text-white mb-2">
          Role Definitions
        </h3>
        <ul className="text-sm text-slate-600 dark:text-slate-300 space-y-1">
          <li>
            <strong className="text-slate-900 dark:text-white">
              Administrator:
            </strong>{' '}
            Full system access including user and system management
          </li>
          <li>
            <strong className="text-slate-900 dark:text-white">
              Power User:
            </strong>{' '}
            Can create and edit all item types, manage workflows
          </li>
          <li>
            <strong className="text-slate-900 dark:text-white">
              Approver:
            </strong>{' '}
            Can approve items and change states, limited editing
          </li>
          <li>
            <strong className="text-slate-900 dark:text-white">User:</strong>{' '}
            Can create and edit draft items, view released items
          </li>
          <li>
            <strong className="text-slate-900 dark:text-white">
              View Only:
            </strong>{' '}
            Read-only access to all items
          </li>
        </ul>
      </div>
    </div>
  )
}
