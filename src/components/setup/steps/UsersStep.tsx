// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { useEffect, useState } from 'react'
import { CheckCircle, Loader2, Plus, UserPlus, Users } from 'lucide-react'
import { strings } from '../strings'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface RoleSummary {
  id: string
  name: string
}

interface UserDraft {
  email: string
  name: string
  password: string
  roleId: string
}

interface CreatedUser {
  id: string
  email: string
  name: string
  roleName: string
}

const EMPTY_DRAFT: UserDraft = {
  email: '',
  name: '',
  password: '',
  roleId: '',
}

interface UsersStepProps {
  onCompleted: () => void
}

export function UsersStep({ onCompleted }: UsersStepProps) {
  const [roles, setRoles] = useState<Array<RoleSummary>>([])
  const [draft, setDraft] = useState<UserDraft>(EMPTY_DRAFT)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<Array<CreatedUser>>([])
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/api/v1/roles')
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (cancelled || !json) return
        const list = (json.data?.roles ?? []) as Array<RoleSummary>
        setRoles(list)
        if (list.length > 0 && !draft.roleId) {
          const defaultRole = list.find((r) => r.name === 'User') ?? list[0]
          if (defaultRole) {
            setDraft((d) => ({ ...d, roleId: defaultRole.id }))
          }
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleAdd = async () => {
    if (!draft.email.trim() || !draft.name.trim() || !draft.password) {
      setError('Email, name, and password are required')
      return
    }
    if (draft.password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }
    if (!draft.roleId) {
      setError('Pick a role')
      return
    }
    setCreating(true)
    setError('')
    try {
      const response = await fetch('/api/v1/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: draft.email.trim(),
          name: draft.name.trim(),
          password: draft.password,
        }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to create user')
      }
      const json = await response.json()
      const newUser = json.data?.user ?? json.data
      const userId = newUser.id

      // Assign the chosen role.
      const roleResponse = await fetch(`/api/v1/users/${userId}/roles`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleIds: [draft.roleId] }),
      })
      if (!roleResponse.ok) {
        // User created but role assignment failed — surface but don't block.
        const json2 = await roleResponse.json().catch(() => ({}))
        setError(
          `Created ${newUser.email} but role assignment failed: ${json2.error?.message ?? 'unknown error'}`,
        )
      }

      const role = roles.find((r) => r.id === draft.roleId)
      setCreated((prev) => [
        ...prev,
        {
          id: userId,
          email: newUser.email ?? draft.email,
          name: newUser.name ?? draft.name,
          roleName: role?.name ?? 'User',
        },
      ])
      setDraft({ ...EMPTY_DRAFT, roleId: draft.roleId })
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setCreating(false)
    }
  }

  const handleContinue = () => {
    onCompleted()
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Users className="w-6 h-6 text-slate-700 dark:text-slate-300" />
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
            {strings.steps.users.title}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {strings.steps.users.description}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="user-email">Email</Label>
              <Input
                id="user-email"
                type="email"
                value={draft.email}
                onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                placeholder="alex@acme-robotics.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-name">Name</Label>
              <Input
                id="user-name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Alex Patel"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-password">Initial password</Label>
              <Input
                id="user-password"
                type="password"
                value={draft.password}
                onChange={(e) =>
                  setDraft({ ...draft, password: e.target.value })
                }
                placeholder="At least 8 characters"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="user-role">Role</Label>
              <Select
                value={draft.roleId}
                onValueChange={(v) => setDraft({ ...draft, roleId: v })}
              >
                <SelectTrigger id="user-role">
                  <SelectValue placeholder="Pick a role" />
                </SelectTrigger>
                <SelectContent>
                  {roles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}

          <div className="flex items-center gap-3">
            <Button onClick={handleAdd} disabled={creating} variant="outline">
              {creating ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Add user
            </Button>
            <Button onClick={handleContinue} disabled={creating}>
              <UserPlus className="w-4 h-4 mr-2" />
              Continue
            </Button>
          </div>
        </CardContent>
      </Card>

      {created.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Added in this session
          </h3>
          <div className="space-y-1">
            {created.map((user) => (
              <div
                key={user.id}
                className="flex items-center gap-3 px-3 py-2 rounded border border-slate-200 dark:border-slate-700"
              >
                <CheckCircle className="w-4 h-4 text-green-600 dark:text-green-400" />
                <span className="text-sm text-slate-900 dark:text-slate-100">
                  {user.name}
                </span>
                <span className="text-sm text-slate-500 dark:text-slate-400">
                  {user.email}
                </span>
                <Badge variant="outline" className="ml-auto">
                  {user.roleName}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
