// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Shield, Trash2, UserPlus } from 'lucide-react'
import type {
  Program,
  ProgramMember,
  ProgramMemberRole,
} from '@/lib/types/program'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  SearchableSelect,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import {
  activeUserListQuery,
  authSessionQuery,
  programMembersQuery,
  useInvalidateResources,
} from '@/lib/query'
import { apiFetch } from '@/lib/api/client'

const ROLE_OPTIONS: Array<{ value: ProgramMemberRole; label: string }> = [
  { value: 'admin', label: 'Admin' },
  { value: 'lead', label: 'Lead' },
  { value: 'engineer', label: 'Engineer' },
  { value: 'viewer', label: 'Viewer' },
]

function roleVariant(
  role: string,
): 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline' {
  switch (role) {
    case 'admin':
      return 'destructive'
    case 'lead':
      return 'warning'
    case 'engineer':
      return 'default'
    default:
      return 'secondary'
  }
}

function flagBadge(label: string, on: boolean | null) {
  return (
    <Badge
      variant={on ? 'success' : 'outline'}
      className={on ? '' : 'opacity-50'}
    >
      {label}
    </Badge>
  )
}

/**
 * The program's team: who is a member, in which program role, with which
 * ECO/product flags.
 *
 * Everyone with access to the program sees the list; add/edit/remove render
 * only for program admins (add also for leads, without the admin role
 * option) and top-level administrators. That gating is presentation only —
 * every mutation is re-checked server-side by the members routes.
 */
export function ProgramTeamCard({ program }: { program: Program }) {
  const { data: members = [] } = useQuery(programMembersQuery(program.id))
  const { data: session } = useQuery(authSessionQuery())
  const { confirm } = useAlertDialog()
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()

  const isSystemAdmin = session?.setupStatus?.isAdmin ?? false
  const isProgramAdmin = program.userRole === 'admin' || isSystemAdmin
  const canAddMembers = isProgramAdmin || program.userRole === 'lead'
  // A lead may add members but not mint admins — mirror the server rule so
  // the option is not offered and then rejected.
  const grantableRoles = isProgramAdmin
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter((r) => r.value !== 'admin')

  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<ProgramMember | null>(null)

  const removeMember = (member: ProgramMember) => {
    confirm({
      title: 'Remove member',
      description: `Remove ${member.user.name ?? member.user.email} from ${program.code}? They will lose access to everything in this program.`,
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(
            `/api/v1/programs/${program.id}/members/${member.userId}`,
            { method: 'DELETE' },
          )
          showSuccess('Member removed', `${member.user.email} was removed`)
          await invalidate('programs')
        } catch (error) {
          handleError(error, { title: 'Failed to remove member' })
        }
      },
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle>Team</CardTitle>
          <CardDescription>
            {members.length} {members.length === 1 ? 'member' : 'members'} of
            this program
          </CardDescription>
        </div>
        {canAddMembers && (
          <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
            <UserPlus className="h-4 w-4 mr-2" />
            Add Member
          </Button>
        )}
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Permissions</TableHead>
              <TableHead>Joined</TableHead>
              {isProgramAdmin && <TableHead className="w-24" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <div>
                    <p className="font-medium text-slate-900 dark:text-white">
                      {member.user.name ?? member.user.email}
                    </p>
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      {member.user.email}
                    </p>
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={roleVariant(member.role)}>
                    {member.role}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {flagBadge('Create ECO', member.canCreateEco)}
                    {flagBadge('Approve ECO', member.canApproveEco)}
                    {flagBadge('Manage Designs', member.canManageDesigns)}
                  </div>
                </TableCell>
                <TableCell className="text-slate-500 dark:text-slate-400">
                  {new Date(member.joinedAt).toLocaleDateString()}
                </TableCell>
                {isProgramAdmin && (
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Edit role & permissions"
                        onClick={() => setEditing(member)}
                      >
                        <Shield className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title="Remove from program"
                        onClick={() => removeMember(member)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      {canAddMembers && (
        <AddMemberDialog
          program={program}
          existingUserIds={members.map((m) => m.userId)}
          grantableRoles={grantableRoles}
          open={addOpen}
          onOpenChange={setAddOpen}
        />
      )}
      {editing && (
        <EditMemberDialog
          program={program}
          member={editing}
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
        />
      )}
    </Card>
  )
}

function AddMemberDialog({
  program,
  existingUserIds,
  grantableRoles,
  open,
  onOpenChange,
}: {
  program: Program
  existingUserIds: Array<string>
  grantableRoles: Array<{ value: ProgramMemberRole; label: string }>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()
  // Only fetch the picker list once the dialog is opened by someone who may
  // add members.
  const { data: users = [] } = useQuery({
    ...activeUserListQuery(),
    enabled: open,
  })

  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<ProgramMemberRole>('engineer')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const candidates = users.filter((u) => !existingUserIds.includes(u.id))

  const handleAdd = async () => {
    if (!userId) return
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/v1/programs/${program.id}/members`, {
        method: 'POST',
        body: JSON.stringify({ userId, role }),
      })
      showSuccess('Member added', 'The user now has access to this program')
      setUserId('')
      setRole('engineer')
      onOpenChange(false)
      await invalidate('programs')
    } catch (error) {
      handleError(error, { title: 'Failed to add member' })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add team member</DialogTitle>
          <DialogDescription>
            Grant a user access to {program.code}. Their program role sets the
            default ECO and product permissions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>User</Label>
            <SearchableSelect
              value={userId}
              onValueChange={setUserId}
              options={candidates.map((u) => ({
                value: u.id,
                label: u.name ? `${u.name} (${u.email})` : u.email,
              }))}
              placeholder="Select a user…"
              searchPlaceholder="Search users…"
              emptyMessage="No users available to add."
            />
          </div>
          <div className="space-y-2">
            <Label>Program role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as ProgramMemberRole)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {grantableRoles.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!userId || isSubmitting}>
            {isSubmitting ? 'Adding…' : 'Add Member'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditMemberDialog({
  program,
  member,
  onOpenChange,
}: {
  program: Program
  member: ProgramMember
  onOpenChange: (open: boolean) => void
}) {
  const { handleError, showSuccess } = useErrorHandler()
  const invalidate = useInvalidateResources()

  const [role, setRole] = useState<ProgramMemberRole>(member.role)
  const [canCreateEco, setCanCreateEco] = useState(!!member.canCreateEco)
  const [canApproveEco, setCanApproveEco] = useState(!!member.canApproveEco)
  const [canManageDesigns, setCanManageDesigns] = useState(
    !!member.canManageDesigns,
  )
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSave = async () => {
    setIsSubmitting(true)
    try {
      await apiFetch(
        `/api/v1/programs/${program.id}/members/${member.userId}`,
        {
          method: 'PUT',
          body: JSON.stringify({
            role,
            canCreateEco,
            canApproveEco,
            canManageDesigns,
          }),
        },
      )
      showSuccess('Member updated', `${member.user.email} was updated`)
      onOpenChange(false)
      await invalidate('programs')
    } catch (error) {
      handleError(error, { title: 'Failed to update member' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const flags: Array<{
    label: string
    value: boolean
    set: (v: boolean) => void
  }> = [
    { label: 'Can create ECOs', value: canCreateEco, set: setCanCreateEco },
    { label: 'Can approve ECOs', value: canApproveEco, set: setCanApproveEco },
    {
      label: 'Can manage designs',
      value: canManageDesigns,
      set: setCanManageDesigns,
    },
  ]

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit team member</DialogTitle>
          <DialogDescription>
            {member.user.name ?? member.user.email} — changing the role resets
            these permissions to the role's defaults unless you set them here.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Program role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as ProgramMemberRole)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3">
            {flags.map((flag) => (
              <label
                key={flag.label}
                className="flex items-center gap-3 cursor-pointer"
              >
                <Checkbox
                  checked={flag.value}
                  onCheckedChange={(checked) => flag.set(checked === true)}
                />
                <span className="text-sm text-slate-900 dark:text-slate-100">
                  {flag.label}
                </span>
              </label>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
