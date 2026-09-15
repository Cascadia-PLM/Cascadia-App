// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { PermissionAction, ResourceType } from '@/lib/auth/permissions'
import { Checkbox, Label, Switch } from '@/components/ui'
import { PERMISSION_ACTIONS, RESOURCE_TYPES } from '@/lib/auth/permissions'

export interface ScopeState {
  restrictPermissions: boolean
  permissions: Record<string, Array<string>>
  restrictRoles: boolean
  roles: Array<string>
}

export const UNRESTRICTED_SCOPE: ScopeState = {
  restrictPermissions: false,
  permissions: {},
  restrictRoles: true,
  roles: [],
}

/** Turn a stored key's scope columns back into editor state. */
export function scopeStateFromKey(key: {
  permissions: Record<string, Array<string>> | null
  roles: Array<string> | null
}): ScopeState {
  return {
    restrictPermissions: key.permissions !== null,
    permissions: key.permissions ?? {},
    restrictRoles: key.roles !== null,
    roles: key.roles ?? [],
  }
}

/** Turn editor state into the request body the API expects. */
export function scopeStateToPayload(scope: ScopeState): {
  permissions: Record<string, Array<string>> | null
  roles: Array<string> | null
} {
  return {
    permissions: scope.restrictPermissions ? scope.permissions : null,
    roles: scope.restrictRoles ? scope.roles : null,
  }
}

interface ApiKeyScopeEditorProps {
  value: ScopeState
  onChange: (next: ScopeState) => void
  /** Roles the key's owner holds — the ceiling on what can be granted. */
  scopableRoles: Array<string>
}

/**
 * The two-axis scope editor, shared by create and edit.
 *
 * Roles come first deliberately. Permissions are the axis people expect and
 * will configure carefully; roles are the one that silently grants everything
 * if left alone, so it gets top billing and defaults to restricted.
 */
export function ApiKeyScopeEditor({
  value,
  onChange,
  scopableRoles,
}: ApiKeyScopeEditorProps) {
  const toggleAction = (resource: ResourceType, action: PermissionAction) => {
    const current = value.permissions[resource] ?? []
    const nextActions = current.includes(action)
      ? current.filter((a) => a !== action)
      : [...current, action]

    const permissions = { ...value.permissions }
    if (nextActions.length === 0) {
      delete permissions[resource]
    } else {
      permissions[resource] = nextActions
    }
    onChange({ ...value, permissions })
  }

  const toggleResourceRow = (resource: ResourceType) => {
    const permissions = { ...value.permissions }
    if (permissions[resource]) {
      delete permissions[resource]
    } else {
      permissions[resource] = ['read']
    }
    onChange({ ...value, permissions })
  }

  return (
    <div className="space-y-5">
      {/* Role scope */}
      <div className="space-y-3">
        <div className="flex items-start gap-3">
          <Switch
            id="restrict-roles"
            checked={value.restrictRoles}
            onCheckedChange={(checked) =>
              onChange({ ...value, restrictRoles: checked })
            }
          />
          <div>
            <Label htmlFor="restrict-roles">Restrict roles</Label>
            <p className="text-xs text-muted-foreground">
              Roles are checked separately from permissions. Turn this off and
              the key clears every role gate its owner can — including
              branch-protection bypass on import.
            </p>
          </div>
        </div>

        {value.restrictRoles && (
          <div className="pl-11 space-y-2">
            {scopableRoles.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                The owner holds no roles, so this key clears no role gates.
              </p>
            ) : (
              scopableRoles.map((role) => (
                <label key={role} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={value.roles.includes(role)}
                    onCheckedChange={(checked) =>
                      onChange({
                        ...value,
                        roles:
                          checked === true
                            ? [...value.roles, role]
                            : value.roles.filter((r) => r !== role),
                      })
                    }
                  />
                  {role}
                </label>
              ))
            )}
            {value.roles.length === 0 && scopableRoles.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Nothing selected — the key clears no role gates. This is the
                right default for most integrations.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Permission scope */}
      <div className="space-y-3 border-t border-slate-200 dark:border-slate-700 pt-4">
        <div className="flex items-start gap-3">
          <Switch
            id="restrict-permissions"
            checked={value.restrictPermissions}
            onCheckedChange={(checked) =>
              onChange({ ...value, restrictPermissions: checked })
            }
          />
          <div>
            <Label htmlFor="restrict-permissions">Restrict permissions</Label>
            <p className="text-xs text-muted-foreground">
              Off means the key inherits the owner&apos;s full role-derived
              permissions.
            </p>
          </div>
        </div>

        {value.restrictPermissions && (
          <div className="pl-11 max-h-72 overflow-y-auto border border-slate-200 dark:border-slate-700 rounded">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-50 dark:bg-slate-800">
                <tr>
                  <th className="text-left p-2 font-medium">Resource</th>
                  {PERMISSION_ACTIONS.map((action) => (
                    <th key={action} className="p-2 font-medium capitalize">
                      {action}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {RESOURCE_TYPES.map((resource) => {
                  const actions = value.permissions[resource] ?? []
                  return (
                    <tr
                      key={resource}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="p-2">
                        <label className="flex items-center gap-2 capitalize cursor-pointer">
                          <Checkbox
                            checked={actions.length > 0}
                            onCheckedChange={() => toggleResourceRow(resource)}
                          />
                          {resource.replace(/_/g, ' ')}
                        </label>
                      </td>
                      {PERMISSION_ACTIONS.map((action) => (
                        <td key={action} className="p-2 text-center">
                          <Checkbox
                            checked={actions.includes(action)}
                            onCheckedChange={() =>
                              toggleAction(resource, action)
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}

        {value.restrictPermissions &&
          Object.keys(value.permissions).length === 0 && (
            <p className="pl-11 text-xs text-amber-600 dark:text-amber-400">
              No permissions selected — this key can authenticate but will be
              denied at every permission gate.
            </p>
          )}
      </div>
    </div>
  )
}
