import { useEffect, useState } from 'react'
import type { Role, UserWithRoles } from '@/lib/auth/types'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'

interface RoleAssignmentDialogProps {
  user: UserWithRoles | null
  roles: Array<Role>
  open: boolean
  onClose: () => void
  onSave: (userId: string, roleIds: Array<string>) => Promise<void>
}

export function RoleAssignmentDialog({
  user,
  roles,
  open,
  onClose,
  onSave,
}: RoleAssignmentDialogProps) {
  const { alert } = useAlertDialog()
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set())
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    if (user) {
      setSelectedRoles(new Set(user.roles.map((r) => r.id)))
    }
  }, [user])

  const handleToggleRole = (roleId: string) => {
    const newSelected = new Set(selectedRoles)
    if (newSelected.has(roleId)) {
      newSelected.delete(roleId)
    } else {
      newSelected.add(roleId)
    }
    setSelectedRoles(newSelected)
  }

  const handleSave = async () => {
    if (!user) return

    setIsSubmitting(true)
    try {
      await onSave(user.id, Array.from(selectedRoles))
      onClose()
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to assign roles',
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!user) return null

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Manage Roles</DialogTitle>
          <DialogDescription>
            Assign roles to {user.name || user.email}
          </DialogDescription>
        </DialogHeader>

        <div className="py-6 space-y-4">
          {roles.length === 0 ? (
            <p className="text-sm text-slate-500">No roles available</p>
          ) : (
            roles.map((role) => (
              <label
                key={role.id}
                className="flex items-start gap-3 p-3 rounded-lg border border-slate-300 dark:border-slate-700 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-900"
              >
                <Checkbox
                  checked={selectedRoles.has(role.id)}
                  onCheckedChange={() => handleToggleRole(role.id)}
                  className="mt-0.5"
                />
                <div className="flex-1">
                  <div className="font-medium text-slate-900 dark:text-slate-100">
                    {role.name}
                  </div>
                  {role.description && (
                    <div className="text-sm text-slate-500 dark:text-slate-400">
                      {role.description}
                    </div>
                  )}
                </div>
              </label>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? 'Saving...' : 'Save Roles'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
