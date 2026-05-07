import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, Mail, Plus, Trash2, X } from 'lucide-react'
import type {
  ActionType,
  CreateTaskConfig,
  DefinitionType,
  FieldOperator,
  GuardType,
  LifecycleType,
  NotificationRecipient,
  NotificationRecipientType,
  SendNotificationConfig,
  TransitionAction,
  TransitionDrivenItemConfig,
  TransitionGuard,
  UpdateFieldConfig,
  WorkflowTransition,
} from '@/lib/workflows/types'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  LoadingSpinner,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface TransitionPropertiesPanelProps {
  transition: WorkflowTransition
  definitionType: DefinitionType
  lifecycleType?: LifecycleType
  onUpdate: (transition: WorkflowTransition) => void
  onDelete: (transitionId: string) => void
  onClose: () => void
}

const guardTypes: Array<{ value: GuardType; label: string }> = [
  { value: 'field_value', label: 'Field Value' },
  { value: 'user_role', label: 'User Role' },
  { value: 'approval_count', label: 'Approval Count' },
]

const fieldOperators: Array<{ value: FieldOperator; label: string }> = [
  { value: 'equals', label: 'Equals' },
  { value: 'not_equals', label: 'Not Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'is_empty', label: 'Is Empty' },
  { value: 'is_not_empty', label: 'Is Not Empty' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
]

const baseActionTypes: Array<{ value: ActionType; label: string }> = [
  { value: 'send_notification', label: 'Send Notification' },
  { value: 'update_field', label: 'Update Field' },
  { value: 'create_task', label: 'Create Task' },
]

const drivingActionTypes: Array<{ value: ActionType; label: string }> = [
  ...baseActionTypes,
  { value: 'transition_driven_item', label: 'Transition Driven Items' },
]

// Types for fetched data
interface UserOption {
  id: string
  name: string | null
  email: string
}

interface RoleOption {
  id: string
  name: string
}

export function TransitionPropertiesPanel({
  transition,
  definitionType,
  lifecycleType,
  onUpdate,
  onDelete,
  onClose,
}: TransitionPropertiesPanelProps) {
  const [expandedGuards, setExpandedGuards] = useState<Set<string>>(new Set())
  const [expandedActions, setExpandedActions] = useState<Set<string>>(new Set())
  const [users, setUsers] = useState<Array<UserOption>>([])
  const [roles, setRoles] = useState<Array<RoleOption>>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const [loadingRoles, setLoadingRoles] = useState(false)
  const [drivenLifecycles, setDrivenLifecycles] = useState<
    Array<{
      id: string
      name: string
      states: Array<{ id: string; name: string }>
    }>
  >([])

  const isWorkflow = definitionType === 'workflow'
  const isDriving = lifecycleType === 'Driving'
  const actionTypes = isDriving ? drivingActionTypes : baseActionTypes

  // Fetch users and roles for notification recipient selection
  useEffect(() => {
    const fetchUsers = async () => {
      setLoadingUsers(true)
      try {
        const response = await fetch('/api/v1/users')
        if (response.ok) {
          const data = await response.json()
          setUsers(data.data?.users || [])
        }
      } catch {
        // Silently fail - users list is optional for notification configuration
      } finally {
        setLoadingUsers(false)
      }
    }

    const fetchRoles = async () => {
      setLoadingRoles(true)
      try {
        const response = await fetch('/api/v1/roles')
        if (response.ok) {
          const data = await response.json()
          setRoles(data.roles || [])
        }
      } catch {
        // Silently fail - roles list is optional for notification configuration
      } finally {
        setLoadingRoles(false)
      }
    }

    // Only fetch if this is a workflow (actions are only for workflows)
    if (isWorkflow) {
      fetchUsers()
      fetchRoles()
    }
  }, [isWorkflow])

  // Fetch Driven lifecycles for TransitionDrivenItem action config
  useEffect(() => {
    const fetchDrivenLifecycles = async () => {
      try {
        const response = await fetch('/api/v1/workflows?type=lifecycle')
        if (response.ok) {
          const data = await response.json()
          const lifecycles = data.data?.workflows || []
          // Filter for Driven lifecycles and map to simpler structure
          const driven = lifecycles
            .filter(
              (w: any) =>
                w.lifecycleType === 'Driven' ||
                (w.definitionType === 'lifecycle' && !w.lifecycleType),
            )
            .map((w: any) => ({
              id: w.id,
              name: w.name,
              states: w.states || [],
            }))
          setDrivenLifecycles(driven)
        }
      } catch {
        // Silently fail
      }
    }

    if (isDriving) {
      fetchDrivenLifecycles()
    }
  }, [isDriving])

  // Helper to update transition and immediately propagate changes
  const handleChange = (updates: Partial<WorkflowTransition>) => {
    onUpdate({ ...transition, ...updates })
  }

  const toggleGuardExpanded = (id: string) => {
    setExpandedGuards((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleActionExpanded = (id: string) => {
    setExpandedActions((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const addGuard = () => {
    const newGuard: TransitionGuard = {
      id: `guard-${Date.now()}`,
      name: 'New Guard',
      type: 'field_value',
      config: { fieldName: '', operator: 'is_not_empty' },
    }
    handleChange({ guards: [...(transition.guards || []), newGuard] })
    setExpandedGuards((prev) => new Set([...prev, newGuard.id]))
  }

  const updateGuard = (index: number, updates: Partial<TransitionGuard>) => {
    const newGuards = transition.guards?.map((g, i) =>
      i === index ? { ...g, ...updates } : g,
    )
    handleChange({ guards: newGuards })
  }

  const removeGuard = (index: number) => {
    handleChange({ guards: transition.guards?.filter((_, i) => i !== index) })
  }

  const addAction = () => {
    const newAction: TransitionAction = {
      id: `action-${Date.now()}`,
      name: 'New Action',
      type: 'send_notification',
      executeOn: 'after',
      config: { recipients: [], templateId: 'workflow_transition' },
    }
    handleChange({ actions: [...(transition.actions || []), newAction] })
    setExpandedActions((prev) => new Set([...prev, newAction.id]))
  }

  // Get default config for an action type
  const getDefaultActionConfig = (
    type: ActionType,
  ):
    | SendNotificationConfig
    | UpdateFieldConfig
    | CreateTaskConfig
    | TransitionDrivenItemConfig => {
    switch (type) {
      case 'send_notification':
        return {
          recipients: [],
          templateId: 'workflow_transition',
        } satisfies SendNotificationConfig
      case 'update_field':
        return { fieldName: '', value: '' } satisfies UpdateFieldConfig
      case 'create_task':
        return { taskTemplate: '', assignTo: '' } satisfies CreateTaskConfig
      case 'transition_driven_item':
        return {
          drivenLifecycleId: '',
          fromStateId: '',
          targetStateId: '',
          validateGates: true,
        } satisfies TransitionDrivenItemConfig
    }
  }

  const updateAction = (index: number, updates: Partial<TransitionAction>) => {
    const newActions = transition.actions?.map((a, i) =>
      i === index ? { ...a, ...updates } : a,
    )
    handleChange({ actions: newActions })
  }

  const removeAction = (index: number) => {
    handleChange({ actions: transition.actions?.filter((_, i) => i !== index) })
  }

  return (
    <Card className="w-96 shadow-lg max-h-[80vh] overflow-y-auto">
      <CardHeader className="pb-3 sticky top-0 bg-white dark:bg-slate-900 z-10">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Transition Properties</CardTitle>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="h-6 w-6"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Transition Name */}
        <div className="space-y-1.5">
          <Label htmlFor="transitionName" className="text-xs">
            Name
          </Label>
          <Input
            id="transitionName"
            value={transition.name}
            onChange={(e) => handleChange({ name: e.target.value })}
            className="h-8 text-sm"
            placeholder="e.g., Submit, Approve, Release"
          />
        </div>

        {/* Description */}
        <div className="space-y-1.5">
          <Label htmlFor="transitionDescription" className="text-xs">
            Description
          </Label>
          <textarea
            id="transitionDescription"
            value={transition.description || ''}
            onChange={(e) => handleChange({ description: e.target.value })}
            className="w-full h-16 px-3 py-2 text-sm rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 resize-none"
            placeholder="What happens during this transition?"
          />
        </div>

        {/* Guards Section */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-semibold">Guards</Label>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={addGuard}
              className="h-6 text-xs"
            >
              <Plus className="h-3 w-3 mr-1" />
              Add Guard
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            Conditions that must be met before this transition can occur
          </p>

          {transition.guards?.map((guard, index) => (
            <div
              key={guard.id}
              className="border rounded-md bg-slate-50 dark:bg-slate-900"
            >
              <button
                type="button"
                onClick={() => toggleGuardExpanded(guard.id)}
                className="w-full flex items-center justify-between p-2 hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                <span className="text-sm font-medium">{guard.name}</span>
                <div className="flex items-center gap-1">
                  <span className="text-xs text-slate-500">{guard.type}</span>
                  {expandedGuards.has(guard.id) ? (
                    <ChevronUp className="h-4 w-4" />
                  ) : (
                    <ChevronDown className="h-4 w-4" />
                  )}
                </div>
              </button>

              {expandedGuards.has(guard.id) && (
                <div className="p-2 pt-0 space-y-2 border-t">
                  {/* Guard Name */}
                  <Input
                    value={guard.name}
                    onChange={(e) =>
                      updateGuard(index, { name: e.target.value })
                    }
                    className="h-7 text-xs"
                    placeholder="Guard name"
                  />

                  {/* Guard Type */}
                  <Select
                    value={guard.type}
                    onValueChange={(value: GuardType) =>
                      updateGuard(index, {
                        type: value,
                        config:
                          value === 'field_value'
                            ? { fieldName: '', operator: 'is_not_empty' }
                            : value === 'user_role'
                              ? { requiredRoles: [] }
                              : { requiredCount: 1 },
                      })
                    }
                  >
                    <SelectTrigger className="h-7 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {guardTypes.map((type) => (
                        <SelectItem key={type.value} value={type.value}>
                          {type.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {/* Guard Config based on type */}
                  {guard.type === 'field_value' && (
                    <div className="space-y-2">
                      <Input
                        value={(guard.config as any).fieldName || ''}
                        onChange={(e) =>
                          updateGuard(index, {
                            config: {
                              ...guard.config,
                              fieldName: e.target.value,
                            },
                          })
                        }
                        className="h-7 text-xs"
                        placeholder="Field name (e.g., description)"
                      />
                      <Select
                        value={(guard.config as any).operator || 'is_not_empty'}
                        onValueChange={(value: FieldOperator) =>
                          updateGuard(index, {
                            config: { ...guard.config, operator: value },
                          })
                        }
                      >
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {fieldOperators.map((op) => (
                            <SelectItem key={op.value} value={op.value}>
                              {op.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {!['is_empty', 'is_not_empty'].includes(
                        (guard.config as any).operator,
                      ) && (
                        <Input
                          value={(guard.config as any).value || ''}
                          onChange={(e) =>
                            updateGuard(index, {
                              config: {
                                ...guard.config,
                                value: e.target.value,
                              },
                            })
                          }
                          className="h-7 text-xs"
                          placeholder="Value to compare"
                        />
                      )}
                    </div>
                  )}

                  {guard.type === 'user_role' && (
                    <Input
                      value={((guard.config as any).requiredRoles || []).join(
                        ', ',
                      )}
                      onChange={(e) =>
                        updateGuard(index, {
                          config: {
                            ...guard.config,
                            requiredRoles: e.target.value
                              .split(',')
                              .map((r) => r.trim())
                              .filter(Boolean),
                          },
                        })
                      }
                      className="h-7 text-xs"
                      placeholder="Roles (comma-separated)"
                    />
                  )}

                  {/* Error Message */}
                  <Input
                    value={guard.errorMessage || ''}
                    onChange={(e) =>
                      updateGuard(index, { errorMessage: e.target.value })
                    }
                    className="h-7 text-xs"
                    placeholder="Error message when guard fails"
                  />

                  {/* Remove Guard */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => removeGuard(index)}
                    className="h-6 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                  >
                    <Trash2 className="h-3 w-3 mr-1" />
                    Remove Guard
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Actions Section - Only for Workflows */}
        {isWorkflow && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-semibold">Actions</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={addAction}
                className="h-6 text-xs"
              >
                <Plus className="h-3 w-3 mr-1" />
                Add Action
              </Button>
            </div>
            <p className="text-xs text-slate-500">
              Operations to perform during the transition
            </p>

            {transition.actions?.map((action, index) => (
              <div
                key={action.id}
                className="border rounded-md bg-purple-50 dark:bg-purple-900/20"
              >
                <button
                  type="button"
                  onClick={() => toggleActionExpanded(action.id)}
                  className="w-full flex items-center justify-between p-2 hover:bg-purple-100 dark:hover:bg-purple-900/30"
                >
                  <span className="text-sm font-medium">{action.name}</span>
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-purple-600 dark:text-purple-400">
                      {action.executeOn}
                    </span>
                    {expandedActions.has(action.id) ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </div>
                </button>

                {expandedActions.has(action.id) && (
                  <div className="p-2 pt-0 space-y-2 border-t">
                    {/* Action Name */}
                    <Input
                      value={action.name}
                      onChange={(e) =>
                        updateAction(index, { name: e.target.value })
                      }
                      className="h-7 text-xs"
                      placeholder="Action name"
                    />

                    {/* Action Type */}
                    <Select
                      value={action.type}
                      onValueChange={(value: ActionType) =>
                        updateAction(index, {
                          type: value,
                          config: getDefaultActionConfig(value),
                        })
                      }
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {actionTypes.map((type) => (
                          <SelectItem key={type.value} value={type.value}>
                            {type.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Execute On */}
                    <Select
                      value={action.executeOn}
                      onValueChange={(value: 'before' | 'after') =>
                        updateAction(index, { executeOn: value })
                      }
                    >
                      <SelectTrigger className="h-7 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="before">
                          Before Transition
                        </SelectItem>
                        <SelectItem value="after">After Transition</SelectItem>
                      </SelectContent>
                    </Select>

                    {/* Send Notification Configuration */}
                    {action.type === 'send_notification' && (
                      <div className="space-y-2 pt-2 border-t border-purple-200 dark:border-purple-800">
                        <div className="flex items-center gap-1 text-xs font-medium text-purple-700 dark:text-purple-300">
                          <Mail className="h-3 w-3" />
                          Notification Settings
                        </div>

                        {/* Template (read-only for now) */}
                        <div className="text-xs text-slate-600 dark:text-slate-400 bg-slate-100 dark:bg-slate-800 p-2 rounded">
                          <span className="font-medium">Template:</span>{' '}
                          Workflow Transition Notification
                        </div>

                        {/* Recipients */}
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-medium">
                              Recipients
                            </span>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                const config = (action.config as
                                  | SendNotificationConfig
                                  | undefined) ?? {
                                  recipients: [],
                                  templateId: 'workflow_transition',
                                }
                                const newRecipient: NotificationRecipient = {
                                  type: 'role',
                                  id: '',
                                }
                                updateAction(index, {
                                  config: {
                                    ...config,
                                    templateId: 'workflow_transition',
                                    recipients: [
                                      ...config.recipients,
                                      newRecipient,
                                    ],
                                  },
                                })
                              }}
                              className="h-5 text-xs px-2"
                            >
                              <Plus className="h-3 w-3 mr-1" />
                              Add
                            </Button>
                          </div>

                          {(
                            (
                              action.config as
                                | SendNotificationConfig
                                | undefined
                            )?.recipients ?? []
                          ).length === 0 && (
                            <p className="text-xs text-slate-500 italic">
                              No recipients configured
                            </p>
                          )}

                          {(
                            (
                              action.config as
                                | SendNotificationConfig
                                | undefined
                            )?.recipients ?? []
                          ).map((recipient, recipientIndex) => (
                            <div
                              key={recipientIndex}
                              className="flex items-center gap-1"
                            >
                              {/* Recipient Type */}
                              <Select
                                value={recipient.type}
                                onValueChange={(
                                  value: NotificationRecipientType,
                                ) => {
                                  const config =
                                    action.config as SendNotificationConfig
                                  const newRecipients = [...config.recipients]
                                  newRecipients[recipientIndex] = {
                                    ...recipient,
                                    type: value,
                                    id: '',
                                  }
                                  updateAction(index, {
                                    config: {
                                      ...config,
                                      recipients: newRecipients,
                                    },
                                  })
                                }}
                              >
                                <SelectTrigger className="h-6 text-xs w-20">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="user">User</SelectItem>
                                  <SelectItem value="role">Role</SelectItem>
                                </SelectContent>
                              </Select>

                              {/* Recipient ID (User or Role) */}
                              {recipient.type === 'user' ? (
                                <div className="relative flex-1">
                                  <Select
                                    value={recipient.id || ''}
                                    onValueChange={(value) => {
                                      const config =
                                        action.config as SendNotificationConfig
                                      const newRecipients = [
                                        ...config.recipients,
                                      ]
                                      newRecipients[recipientIndex] = {
                                        ...recipient,
                                        id: value,
                                      }
                                      updateAction(index, {
                                        config: {
                                          ...config,
                                          recipients: newRecipients,
                                        },
                                      })
                                    }}
                                  >
                                    <SelectTrigger className="h-6 text-xs">
                                      <SelectValue placeholder="Select user" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {users.map((user) => (
                                        <SelectItem
                                          key={user.id}
                                          value={user.id}
                                        >
                                          {user.name || user.email}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {loadingUsers && (
                                    <div className="absolute right-6 top-1/2 -translate-y-1/2">
                                      <LoadingSpinner size="sm" />
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="relative flex-1">
                                  <Select
                                    value={recipient.id || ''}
                                    onValueChange={(value) => {
                                      const config =
                                        action.config as SendNotificationConfig
                                      const newRecipients = [
                                        ...config.recipients,
                                      ]
                                      newRecipients[recipientIndex] = {
                                        ...recipient,
                                        id: value,
                                      }
                                      updateAction(index, {
                                        config: {
                                          ...config,
                                          recipients: newRecipients,
                                        },
                                      })
                                    }}
                                  >
                                    <SelectTrigger className="h-6 text-xs">
                                      <SelectValue placeholder="Select role" />
                                    </SelectTrigger>
                                    <SelectContent>
                                      {roles.map((role) => (
                                        <SelectItem
                                          key={role.id}
                                          value={role.id}
                                        >
                                          {role.name}
                                        </SelectItem>
                                      ))}
                                    </SelectContent>
                                  </Select>
                                  {loadingRoles && (
                                    <div className="absolute right-6 top-1/2 -translate-y-1/2">
                                      <LoadingSpinner size="sm" />
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Remove Recipient */}
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => {
                                  const config =
                                    action.config as SendNotificationConfig
                                  const newRecipients =
                                    config.recipients.filter(
                                      (_, i) => i !== recipientIndex,
                                    )
                                  updateAction(index, {
                                    config: {
                                      ...config,
                                      recipients: newRecipients,
                                    },
                                  })
                                }}
                                className="h-6 w-6 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                              >
                                <Trash2 className="h-3 w-3" />
                              </Button>
                            </div>
                          ))}
                        </div>

                        <p className="text-xs text-slate-500">
                          Recipients will only be notified if they have
                          permission to view the item.
                        </p>
                      </div>
                    )}

                    {/* Transition Driven Item Configuration */}
                    {action.type === 'transition_driven_item' && (
                      <div className="space-y-2 pt-2 border-t border-cyan-200 dark:border-cyan-800">
                        <div className="text-xs font-medium text-cyan-700 dark:text-cyan-300">
                          Transition Driven Items Settings
                        </div>

                        {drivenLifecycles.length === 0 ? (
                          <p className="text-xs text-slate-500 italic">
                            No Driven lifecycles found. Create a lifecycle for
                            Parts or Documents first.
                          </p>
                        ) : (
                          <>
                            {/* Driven Lifecycle Selection */}
                            <div className="space-y-1">
                              <Label className="text-xs">
                                Driven Lifecycle
                              </Label>
                              <Select
                                value={
                                  (action.config as TransitionDrivenItemConfig)
                                    .drivenLifecycleId || ''
                                }
                                onValueChange={(value) => {
                                  const config =
                                    action.config as TransitionDrivenItemConfig
                                  // Reset state selections when lifecycle changes
                                  updateAction(index, {
                                    config: {
                                      ...config,
                                      drivenLifecycleId: value,
                                      fromStateId: '',
                                      targetStateId: '',
                                    },
                                  })
                                }}
                              >
                                <SelectTrigger className="h-7 text-xs">
                                  <SelectValue placeholder="Select lifecycle" />
                                </SelectTrigger>
                                <SelectContent>
                                  {drivenLifecycles
                                    .filter((lifecycle) => {
                                      // Check if another TDI action already uses this lifecycle
                                      const existingAction =
                                        transition.actions?.find(
                                          (a) =>
                                            a.id !== action.id &&
                                            a.type ===
                                              'transition_driven_item' &&
                                            (
                                              a.config as TransitionDrivenItemConfig
                                            ).drivenLifecycleId ===
                                              lifecycle.id,
                                        )
                                      return !existingAction
                                    })
                                    .map((lifecycle) => (
                                      <SelectItem
                                        key={lifecycle.id}
                                        value={lifecycle.id}
                                      >
                                        {lifecycle.name}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                              <p className="text-xs text-slate-500">
                                Which lifecycle&apos;s items to transition
                              </p>
                            </div>

                            {/* From State Selection */}
                            {(action.config as TransitionDrivenItemConfig)
                              .drivenLifecycleId && (
                              <div className="space-y-1">
                                <Label className="text-xs">From State</Label>
                                <Select
                                  value={
                                    (
                                      action.config as TransitionDrivenItemConfig
                                    ).fromStateId || ''
                                  }
                                  onValueChange={(value) => {
                                    const config =
                                      action.config as TransitionDrivenItemConfig
                                    updateAction(index, {
                                      config: { ...config, fromStateId: value },
                                    })
                                  }}
                                >
                                  <SelectTrigger className="h-7 text-xs">
                                    <SelectValue placeholder="Select from state" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {drivenLifecycles
                                      .find(
                                        (l) =>
                                          l.id ===
                                          (
                                            action.config as TransitionDrivenItemConfig
                                          ).drivenLifecycleId,
                                      )
                                      ?.states.map((state) => (
                                        <SelectItem
                                          key={state.id}
                                          value={state.id}
                                        >
                                          {state.name}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                                <p className="text-xs text-slate-500">
                                  Items must be in this state to be transitioned
                                </p>
                              </div>
                            )}

                            {/* Target State Selection */}
                            {(action.config as TransitionDrivenItemConfig)
                              .drivenLifecycleId && (
                              <div className="space-y-1">
                                <Label className="text-xs">To State</Label>
                                <Select
                                  value={
                                    (
                                      action.config as TransitionDrivenItemConfig
                                    ).targetStateId || ''
                                  }
                                  onValueChange={(value) => {
                                    const config =
                                      action.config as TransitionDrivenItemConfig
                                    updateAction(index, {
                                      config: {
                                        ...config,
                                        targetStateId: value,
                                      },
                                    })
                                  }}
                                >
                                  <SelectTrigger className="h-7 text-xs">
                                    <SelectValue placeholder="Select target state" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {drivenLifecycles
                                      .find(
                                        (l) =>
                                          l.id ===
                                          (
                                            action.config as TransitionDrivenItemConfig
                                          ).drivenLifecycleId,
                                      )
                                      ?.states.map((state) => (
                                        <SelectItem
                                          key={state.id}
                                          value={state.id}
                                        >
                                          {state.name}
                                        </SelectItem>
                                      ))}
                                  </SelectContent>
                                </Select>
                                <p className="text-xs text-slate-500">
                                  Items will be transitioned to this state
                                </p>
                              </div>
                            )}

                            {/* Validate Gates Checkbox */}
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                id={`validateGates-${action.id}`}
                                checked={
                                  (action.config as TransitionDrivenItemConfig)
                                    .validateGates
                                }
                                onChange={(e) => {
                                  const config =
                                    action.config as TransitionDrivenItemConfig
                                  updateAction(index, {
                                    config: {
                                      ...config,
                                      validateGates: e.target.checked,
                                    },
                                  })
                                }}
                                className="rounded"
                              />
                              <Label
                                htmlFor={`validateGates-${action.id}`}
                                className="text-xs"
                              >
                                Validate destination state gates
                              </Label>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Remove Action */}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeAction(index)}
                      className="h-6 text-xs text-red-600 hover:text-red-700 hover:bg-red-50"
                    >
                      <Trash2 className="h-3 w-3 mr-1" />
                      Remove Action
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Approval Requirement - Only for Workflows */}
        {isWorkflow && (
          <div className="space-y-2">
            <Label className="text-xs font-semibold">
              Approval Requirement
            </Label>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={!!transition.approvalRequirement}
                  onChange={(e) =>
                    handleChange({
                      approvalRequirement: e.target.checked
                        ? { requiredCount: 1 }
                        : undefined,
                    })
                  }
                  className="rounded"
                />
                Require approvals
              </label>
            </div>
            {transition.approvalRequirement && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={transition.approvalRequirement.requiredCount}
                  onChange={(e) =>
                    handleChange({
                      approvalRequirement: {
                        ...transition.approvalRequirement!,
                        requiredCount: parseInt(e.target.value) || 1,
                      },
                    })
                  }
                  className="h-7 w-16 text-xs"
                />
                <span className="text-xs text-slate-500">
                  approval(s) required
                </span>
              </div>
            )}
          </div>
        )}

        {/* Delete Transition */}
        <div className="pt-2 border-t">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onDelete(transition.id)}
            className="text-red-600 hover:text-red-700 hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4 mr-1" />
            Delete Transition
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
