// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Plus, Trash2, User, Users } from 'lucide-react'
import {
  Button,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useInvalidateResources } from '@/lib/query/hooks'
import { stateApproversQuery } from '@/lib/query/options/workflows'
import { activeUserListQuery, roleListQuery } from '@/lib/query/options/users'

interface StateApproversPanelProps {
  workflowDefinitionId: string
  stateId: string
}

export function StateApproversPanel({
  workflowDefinitionId,
  stateId,
}: StateApproversPanelProps) {
  const [saving, setSaving] = useState(false)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newApproverType, setNewApproverType] = useState<'user' | 'role'>(
    'role',
  )
  const [newApproverId, setNewApproverId] = useState<string>('')
  const [newApproverRequired, setNewApproverRequired] = useState(true)

  const invalidate = useInvalidateResources()
  const { data: approvers = [], isPending: loading } = useQuery(
    stateApproversQuery(workflowDefinitionId, stateId),
  )
  const { data: users = [] } = useQuery(activeUserListQuery())
  const { data: roles = [] } = useQuery(roleListQuery())

  /** Every write here changes who may approve, so refresh the workflow. */
  const refreshApprovers = () => invalidate('workflows')

  // Add a new approver
  const handleAddApprover = async () => {
    if (!newApproverId) return

    setSaving(true)
    try {
      await apiFetch(
        `/api/v1/workflows/${workflowDefinitionId}/states/${stateId}/approvers`,
        {
          method: 'POST',
          body: JSON.stringify({
            type: newApproverType,
            id: newApproverId,
            isRequired: newApproverRequired,
          }),
        },
      )
      await refreshApprovers()
      setShowAddForm(false)
      setNewApproverId('')
      setNewApproverRequired(true)
    } catch (error) {
      console.error('Failed to add approver:', error)
    } finally {
      setSaving(false)
    }
  }

  // Remove an approver
  const handleRemoveApprover = async (approverId: string) => {
    setSaving(true)
    try {
      await apiFetch(
        `/api/v1/workflows/${workflowDefinitionId}/states/${stateId}/approvers/${approverId}`,
        { method: 'DELETE' },
      )
      await refreshApprovers()
    } catch (error) {
      console.error('Failed to remove approver:', error)
    } finally {
      setSaving(false)
    }
  }

  // Toggle required status
  const handleToggleRequired = async (
    approverId: string,
    isRequired: boolean,
  ) => {
    setSaving(true)
    try {
      await apiFetch(
        `/api/v1/workflows/${workflowDefinitionId}/states/${stateId}/approvers/${approverId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ isRequired }),
        },
      )
      await refreshApprovers()
    } catch (error) {
      console.error('Failed to update approver:', error)
    } finally {
      setSaving(false)
    }
  }

  // Get available options (exclude already added approvers)
  const availableUsers = users.filter(
    (u) =>
      !approvers.some(
        (a) => a.approverType === 'user' && a.approverId === u.id,
      ),
  )
  const availableRoles = roles.filter(
    (r) =>
      !approvers.some(
        (a) => a.approverType === 'role' && a.approverId === r.id,
      ),
  )

  if (loading) {
    return (
      <div className="flex items-center justify-center py-4">
        <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium">Approvers</Label>
        {!showAddForm && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setShowAddForm(true)}
            className="h-6 px-2 text-xs"
          >
            <Plus className="h-3 w-3 mr-1" />
            Add
          </Button>
        )}
      </div>

      {/* Add Approver Form */}
      {showAddForm && (
        <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-md space-y-2">
          <div className="flex gap-2">
            <Select
              value={newApproverType}
              onValueChange={(v: 'user' | 'role') => {
                setNewApproverType(v)
                setNewApproverId('')
              }}
            >
              <SelectTrigger className="h-7 text-xs w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="role">Role</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>

            <Select value={newApproverId} onValueChange={setNewApproverId}>
              <SelectTrigger className="h-7 text-xs flex-1">
                <SelectValue placeholder={`Select ${newApproverType}...`} />
              </SelectTrigger>
              <SelectContent>
                {newApproverType === 'user'
                  ? availableUsers.map((user) => (
                      <SelectItem key={user.id} value={user.id}>
                        {user.name || user.email}
                      </SelectItem>
                    ))
                  : availableRoles.map((role) => (
                      <SelectItem key={role.id} value={role.id}>
                        {role.name}
                      </SelectItem>
                    ))}
              </SelectContent>
            </Select>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={newApproverRequired}
              onChange={(e) => setNewApproverRequired(e.target.checked)}
              className="rounded border-slate-300 dark:border-slate-600 h-3 w-3"
            />
            <span className="text-xs text-slate-600 dark:text-slate-400">
              Required
            </span>
          </label>

          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setShowAddForm(false)
                setNewApproverId('')
              }}
              className="h-6 px-2 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleAddApprover}
              disabled={!newApproverId || saving}
              className="h-6 px-2 text-xs"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {/* Approvers List */}
      {approvers.length === 0 && !showAddForm ? (
        <p className="text-xs text-slate-500 dark:text-slate-400 italic">
          No approvers configured. Anyone can transition from this state.
        </p>
      ) : (
        <div className="space-y-1.5">
          {approvers.map((approver) => (
            <div
              key={approver.id}
              className="flex items-center gap-2 p-2 bg-slate-50 dark:bg-slate-800 rounded-md"
            >
              {approver.approverType === 'role' ? (
                <Users className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
              ) : (
                <User className="h-3.5 w-3.5 text-slate-400 flex-shrink-0" />
              )}
              <span className="text-xs flex-1 truncate">
                {approver.approverName || 'Unknown'}
              </span>
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={approver.isRequired}
                  onChange={(e) =>
                    handleToggleRequired(approver.id, e.target.checked)
                  }
                  disabled={saving}
                  className="rounded border-slate-300 dark:border-slate-600 h-3 w-3"
                />
                <span className="text-xs text-slate-500">Req</span>
              </label>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => handleRemoveApprover(approver.id)}
                disabled={saving}
                className="h-5 w-5 text-slate-400 hover:text-red-500"
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
