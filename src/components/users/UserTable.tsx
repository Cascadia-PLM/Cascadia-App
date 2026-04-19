import { Link } from '@tanstack/react-router'
import { useCallback } from 'react'
import { Edit, Eye, Key, MoreVertical, Shield, Trash2 } from 'lucide-react'
import type { UserWithRoles } from '@/lib/auth/types'
import type { DataGridColumn, Row } from '@/components/ui'
import { Badge, Button, DataGrid } from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/ContextMenu'

interface UserTableProps {
  users: Array<UserWithRoles>
  onEdit?: (user: UserWithRoles) => void
  onDelete?: (user: UserWithRoles) => void
  onManageRoles?: (user: UserWithRoles) => void
  onChangePassword?: (user: UserWithRoles) => void
}

export function UserTable({
  users,
  onEdit,
  onDelete,
  onManageRoles,
  onChangePassword,
}: UserTableProps) {
  const columns: Array<DataGridColumn<UserWithRoles>> = [
    {
      id: 'email',
      header: 'Email',
      accessorKey: 'email',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search emails...',
      cell: ({ row }) =>
        row.original.id ? (
          <Link
            to="/users/$id"
            params={{ id: row.original.id }}
            className="font-medium text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
          >
            {row.original.email}
          </Link>
        ) : (
          <span className="font-medium">{row.original.email}</span>
        ),
    },
    {
      id: 'name',
      header: 'Name',
      accessorKey: 'name',
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Search names...',
      cell: ({ getValue }) => (getValue() as string) || '-',
    },
    {
      id: 'provider',
      header: 'Provider',
      accessorKey: 'provider',
      enableFiltering: true,
      filterType: 'multiSelect',
      filterOptions: [
        { label: 'Local', value: 'local' },
        { label: 'Google', value: 'google' },
        { label: 'Microsoft', value: 'microsoft' },
        { label: 'GitHub', value: 'github' },
      ],
      cell: ({ getValue }) => {
        const value = (getValue() as string) || 'local'
        return <Badge variant="secondary">{value}</Badge>
      },
    },
    {
      id: 'roles',
      header: 'Roles',
      accessorFn: (row) => {
        // Deduplicate roles by ID for filtering/display
        const uniqueRoles = Array.from(
          new Map(row.roles.map((r) => [r.id, r])).values(),
        )
        return uniqueRoles.map((r) => r.name).join(', ')
      },
      enableFiltering: true,
      filterType: 'text',
      filterPlaceholder: 'Filter by role...',
      cell: ({ row }) => {
        const uniqueRoles = Array.from(
          new Map(row.original.roles.map((r) => [r.id, r])).values(),
        )

        return (
          <div className="flex gap-1 flex-wrap">
            {uniqueRoles.length > 0 ? (
              uniqueRoles.map((role) => (
                <Badge key={role.id} variant="default">
                  {role.name}
                </Badge>
              ))
            ) : (
              <span className="text-slate-400 text-sm">No roles</span>
            )}
          </div>
        )
      },
    },
    {
      id: 'active',
      header: 'Status',
      accessorKey: 'active',
      enableFiltering: true,
      filterType: 'select',
      filterOptions: [
        { label: 'Active', value: 'true' },
        { label: 'Inactive', value: 'false' },
      ],
      cell: ({ getValue }) => {
        const isActive = getValue() as boolean
        return (
          <Badge variant={isActive ? 'success' : 'destructive'}>
            {isActive ? 'Active' : 'Inactive'}
          </Badge>
        )
      },
    },
    {
      id: 'lastLogin',
      header: 'Last Login',
      accessorKey: 'lastLogin',
      enableSorting: true,
      cell: ({ getValue }) => {
        const lastLogin = getValue() as string | null
        return lastLogin ? new Date(lastLogin).toLocaleDateString() : 'Never'
      },
    },
  ]

  const renderRowActions = (row: Row<UserWithRoles>) => {
    const user = row.original
    const hasActions =
      user.id || onEdit || onManageRoles || onChangePassword || onDelete
    if (!hasActions) return null

    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="icon" variant="ghost" className="h-8 w-8">
            <MoreVertical className="h-4 w-4" />
            <span className="sr-only">Open menu</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {user.id && (
            <DropdownMenuItem asChild>
              <Link to="/users/$id" params={{ id: user.id }}>
                <Eye className="mr-2 h-4 w-4" />
                View details
              </Link>
            </DropdownMenuItem>
          )}
          {onEdit && (
            <DropdownMenuItem onClick={() => onEdit(user)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
          )}
          {onManageRoles && (
            <DropdownMenuItem onClick={() => onManageRoles(user)}>
              <Shield className="mr-2 h-4 w-4" />
              Manage roles
            </DropdownMenuItem>
          )}
          {onChangePassword && user.provider === 'local' && (
            <DropdownMenuItem onClick={() => onChangePassword(user)}>
              <Key className="mr-2 h-4 w-4" />
              Change password
            </DropdownMenuItem>
          )}
          {onDelete && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => onDelete(user)}
                className="text-red-600 focus:text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  const renderContextMenuItems = useCallback(
    (row: Row<UserWithRoles>) => {
      const user = row.original
      const hasActions = onEdit || onManageRoles || onDelete
      if (!hasActions) return null

      return (
        <>
          {onEdit && (
            <ContextMenuItem onClick={() => onEdit(user)}>
              <Edit className="mr-2 h-4 w-4" />
              Edit
            </ContextMenuItem>
          )}
          {onManageRoles && (
            <ContextMenuItem onClick={() => onManageRoles(user)}>
              <Shield className="mr-2 h-4 w-4" />
              Manage roles
            </ContextMenuItem>
          )}
          {onDelete && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem
                onClick={() => onDelete(user)}
                className="text-red-600 focus:text-red-600"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </ContextMenuItem>
            </>
          )}
        </>
      )
    },
    [onEdit, onManageRoles, onDelete],
  )

  const getRowUrl = useCallback((row: UserWithRoles) => {
    return row.id ? `/users/${row.id}` : undefined
  }, [])

  return (
    <DataGrid
      data={users}
      columns={columns}
      getRowId={(row) => row.id || row.email}
      enableRowActions={true}
      renderRowActions={renderRowActions}
      enableContextMenu
      getRowUrl={getRowUrl}
      renderContextMenuItems={renderContextMenuItems}
      emptyMessage="No users found"
      emptyDescription="Create your first user to get started"
      exportFilename="users"
    />
  )
}
