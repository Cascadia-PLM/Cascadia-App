import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ExternalLink,
  Eye,
  Loader2,
  MoreVertical,
  Package,
  Plus,
  UserMinus,
} from 'lucide-react'

import { AddMemberDialog } from './AddMemberDialog'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'

interface MemberDesign {
  id: string
  code: string
  name: string
  description: string | null
  designType: string
  itemCount: number
  hasReleases: boolean
  latestTag: string | null
  createdAt: string
}

interface MembersTabProps {
  designId: string
  designCode: string
  programId: string | null
  readOnly?: boolean
}

export function MembersTab({
  designId,
  designCode,
  programId,
  readOnly = false,
}: MembersTabProps) {
  const { confirm, alert } = useAlertDialog()
  const [members, setMembers] = useState<Array<MemberDesign>>([])
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(false)

  // Fetch family members
  const fetchMembers = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch<{
        data: { members: Array<MemberDesign> }
      }>(`/api/v1/designs/${designId}/members`)
      setMembers(response.data.members)
    } catch {
      setMembers([])
    } finally {
      setLoading(false)
    }
  }, [designId])

  useEffect(() => {
    fetchMembers()
  }, [fetchMembers])

  // Handle removing a member from the family
  const handleRemoveMember = (memberId: string, memberCode: string) => {
    confirm({
      title: 'Remove from Family',
      description: `Are you sure you want to remove ${memberCode} from the ${designCode} family? The design will become standalone but will not be deleted.`,
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(
            `/api/v1/designs/${designId}/members?designId=${memberId}`,
            {
              method: 'DELETE',
            },
          )
          await fetchMembers()
        } catch (error) {
          alert({
            title: 'Error',
            description: `Failed to remove member: ${(error as Error).message}`,
            variant: 'destructive',
          })
        }
      },
    })
  }

  // Handle successful member add
  const handleMemberAdded = () => {
    setAddDialogOpen(false)
    fetchMembers()
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Member Designs</CardTitle>
              <CardDescription>
                {members.length} design{members.length !== 1 ? 's' : ''} in this
                family
              </CardDescription>
            </div>
            {!readOnly && (
              <Button onClick={() => setAddDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Add Member
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <div className="text-center py-12 border rounded-lg">
              <Package className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
              <p className="text-slate-500 dark:text-slate-400">
                No member designs in this family yet
              </p>
              <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
                Add existing designs or create new ones to organize your
                variants
              </p>
              {!readOnly && (
                <Button
                  onClick={() => setAddDialogOpen(true)}
                  className="mt-4"
                  variant="outline"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Add Member Design
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Items</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Latest Baseline</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {members.map((member) => (
                  <TableRow key={member.id}>
                    <TableCell>
                      <Link
                        to="/designs/$id"
                        params={{ id: member.id }}
                        className="font-medium text-cyan-600 dark:text-cyan-400 hover:underline flex items-center gap-2"
                      >
                        <Package className="h-4 w-4" />
                        {member.code}
                      </Link>
                    </TableCell>
                    <TableCell className="text-slate-600 dark:text-slate-400">
                      {member.name}
                    </TableCell>
                    <TableCell className="text-right">
                      {member.itemCount}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={member.hasReleases ? 'success' : 'secondary'}
                      >
                        {member.hasReleases ? 'Has Releases' : 'In Development'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {member.latestTag ? (
                        <Badge variant="outline">{member.latestTag}</Badge>
                      ) : (
                        <span className="text-slate-400">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                          >
                            <MoreVertical className="h-4 w-4" />
                            <span className="sr-only">Open menu</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link to="/designs/$id" params={{ id: member.id }}>
                              <Eye className="mr-2 h-4 w-4" />
                              View Design
                            </Link>
                          </DropdownMenuItem>
                          <DropdownMenuItem asChild>
                            <Link
                              to="/designs/$id"
                              params={{ id: member.id }}
                              target="_blank"
                            >
                              <ExternalLink className="mr-2 h-4 w-4" />
                              Open in New Tab
                            </Link>
                          </DropdownMenuItem>
                          {!readOnly && (
                            <DropdownMenuItem
                              onClick={() =>
                                handleRemoveMember(member.id, member.code)
                              }
                              className="text-orange-600 focus:text-orange-600"
                            >
                              <UserMinus className="mr-2 h-4 w-4" />
                              Remove from Family
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Add Member Dialog */}
      <AddMemberDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        familyDesignId={designId}
        familyDesignCode={designCode}
        programId={programId}
        existingMemberIds={members.map((m) => m.id)}
        onSuccess={handleMemberAdded}
      />
    </>
  )
}
