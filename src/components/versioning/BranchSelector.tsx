import { useCallback, useEffect, useState } from 'react'
import { GitBranch, Lock, Plus, Unlock } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { Badge, Button, FormField, Input } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface Branch {
  id: string
  name: string
  branchType: 'main' | 'eco' | 'workspace' | 'release'
  isLocked: boolean
  isArchived: boolean
  ownerId?: string
}

interface BranchSelectorProps {
  designId: string
  value?: string
  onChange: (branchId: string) => void
  /**
   * Whether to show the main branch option.
   * If main is protected, it will be disabled.
   */
  showMainOption?: boolean
  disabled?: boolean
  className?: string
  /**
   * Placeholder text when no branch is selected
   */
  placeholder?: string
  /**
   * Callback when user wants to create a new ECO
   */
  onCreateEco?: () => void
}

interface DesignStatus {
  protection: {
    isMainBranchProtected: boolean
  }
}

/**
 * Dropdown to select a branch for item creation/editing.
 * Shows different branch types grouped: Main, ECO branches, Workspace branches
 */
export function BranchSelector({
  designId,
  value,
  onChange,
  showMainOption = true,
  disabled = false,
  className,
  placeholder = 'Select branch...',
  onCreateEco,
}: BranchSelectorProps) {
  const [branches, setBranches] = useState<Array<Branch>>([])
  const [isProtected, setIsProtected] = useState(false)
  const [loading, setLoading] = useState(true)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [newWorkspaceName, setNewWorkspaceName] = useState('')
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const fetchBranches = useCallback(async () => {
    if (!designId) {
      setBranches([])
      setLoading(false)
      return
    }

    setLoading(true)
    try {
      // Fetch branches and status in parallel
      const [branchesRes, statusRes] = await Promise.all([
        apiFetch<{ data: { branches: Array<Branch> } }>(
          `/api/designs/${designId}/branches`,
        ),
        apiFetch<{ data: DesignStatus }>(`/api/designs/${designId}/status`),
      ])
      setBranches(branchesRes.data.branches)
      setIsProtected(statusRes.data.protection.isMainBranchProtected)
    } catch {
      setBranches([])
    } finally {
      setLoading(false)
    }
  }, [designId])

  useEffect(() => {
    fetchBranches()
  }, [fetchBranches])

  const handleCreateWorkspace = async () => {
    if (!newWorkspaceName.trim()) {
      setCreateError('Please enter a name for the workspace')
      return
    }

    setCreating(true)
    setCreateError(null)
    try {
      const result = await apiFetch<{ data: { branch: Branch } }>(
        `/api/designs/${designId}/branches`,
        {
          method: 'POST',
          body: JSON.stringify({
            branchType: 'workspace',
            name: newWorkspaceName.trim(),
          }),
        },
      )
      // Refetch branches and select the new one
      await fetchBranches()
      onChange(result.data.branch.id)
      setShowCreateDialog(false)
      setNewWorkspaceName('')
    } catch (error) {
      setCreateError(
        error instanceof Error ? error.message : 'Failed to create workspace',
      )
    } finally {
      setCreating(false)
    }
  }

  const handleValueChange = (val: string) => {
    if (val === '__create_workspace__') {
      setShowCreateDialog(true)
      return
    }
    if (val === '__create_eco__') {
      onCreateEco?.()
      return
    }
    onChange(val)
  }

  // Group branches by type
  const mainBranch = branches.find((b) => b.branchType === 'main')
  const ecoBranches = branches.filter(
    (b) => b.branchType === 'eco' && !b.isArchived,
  )
  const workspaceBranches = branches.filter(
    (b) => b.branchType === 'workspace' && !b.isArchived,
  )

  // Get selected branch for display
  const selectedBranch = branches.find((b) => b.id === value)

  if (loading) {
    return <div className="h-9 w-48 animate-pulse bg-slate-200 rounded-md" />
  }

  return (
    <>
      <div className={`flex items-center gap-2 ${className ?? ''}`}>
        <Select
          value={value}
          onValueChange={handleValueChange}
          disabled={disabled}
        >
          <SelectTrigger className="w-56">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-slate-500" />
              <SelectValue placeholder={placeholder}>
                {selectedBranch && (
                  <span className="flex items-center gap-2">
                    {selectedBranch.branchType === 'main' &&
                      (isProtected ? (
                        <Lock className="h-3 w-3" />
                      ) : (
                        <Unlock className="h-3 w-3" />
                      ))}
                    {selectedBranch.name}
                  </span>
                )}
              </SelectValue>
            </div>
          </SelectTrigger>
          <SelectContent>
            {/* Main branch */}
            {showMainOption && mainBranch && (
              <SelectGroup>
                <SelectLabel>Main Branch</SelectLabel>
                <SelectItem value={mainBranch.id} disabled={isProtected}>
                  <div className="flex items-center gap-2">
                    {isProtected ? (
                      <Lock className="h-3 w-3 text-slate-400" />
                    ) : (
                      <Unlock className="h-3 w-3 text-green-500" />
                    )}
                    <span>main</span>
                    {isProtected && (
                      <Badge variant="outline" className="text-xs ml-2">
                        Protected
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              </SelectGroup>
            )}

            {/* ECO branches */}
            {ecoBranches.length > 0 && (
              <>
                {showMainOption && mainBranch && <SelectSeparator />}
                <SelectGroup>
                  <SelectLabel>ECO Branches</SelectLabel>
                  {ecoBranches.map((branch) => (
                    <SelectItem
                      key={branch.id}
                      value={branch.id}
                      disabled={branch.isLocked}
                    >
                      <div className="flex items-center gap-2">
                        <Badge variant="default" className="text-xs">
                          ECO
                        </Badge>
                        <span>{branch.name.replace('eco/', '')}</span>
                        {branch.isLocked && (
                          <Badge variant="secondary" className="text-xs ml-2">
                            Locked
                          </Badge>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}

            {/* Workspace branches */}
            {workspaceBranches.length > 0 && (
              <>
                <SelectSeparator />
                <SelectGroup>
                  <SelectLabel>My Workspaces</SelectLabel>
                  {workspaceBranches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      <div className="flex items-center gap-2">
                        <Badge variant="secondary" className="text-xs">
                          WS
                        </Badge>
                        <span>{branch.name.replace('workspace/', '')}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectGroup>
              </>
            )}

            {/* Create new workspace option - always available */}
            <SelectSeparator />
            <SelectGroup>
              <SelectLabel>Create New</SelectLabel>
              <SelectItem value="__create_workspace__">
                <div className="flex items-center gap-2 text-cyan-600">
                  <Plus className="h-3 w-3" />
                  New Workspace...
                </div>
              </SelectItem>
              {onCreateEco && (
                <SelectItem value="__create_eco__">
                  <div className="flex items-center gap-2 text-cyan-600">
                    <Plus className="h-3 w-3" />
                    Create ECO
                  </div>
                </SelectItem>
              )}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {/* Create Workspace Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Workspace</DialogTitle>
            <DialogDescription>
              Create a new private workspace branch for development work.
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            <FormField
              label="Workspace Name"
              required
              error={createError || undefined}
              helpText="Use a descriptive name like 'motor-redesign' or 'prototype-v2'"
            >
              <Input
                placeholder="my-workspace"
                value={newWorkspaceName}
                onChange={(e) => {
                  setNewWorkspaceName(e.target.value)
                  setCreateError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleCreateWorkspace()
                  }
                }}
              />
            </FormField>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowCreateDialog(false)
                setNewWorkspaceName('')
                setCreateError(null)
              }}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateWorkspace} disabled={creating}>
              {creating ? 'Creating...' : 'Create Workspace'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
