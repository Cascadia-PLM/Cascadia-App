import { useEffect, useState } from 'react'
import { AlertTriangle, GitBranch, Loader2, Lock, Plus } from 'lucide-react'
import type { CheckoutStatus } from '@/lib/services/CheckoutService'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { CreateWorkspaceDialog } from '@/components/workspaces/CreateWorkspaceDialog'

interface Branch {
  id: string
  name: string
  branchType: 'main' | 'eco' | 'workspace' | 'release'
  isArchived: boolean
  isLocked: boolean
  changeOrderItemId?: string
}

interface CheckoutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  itemId: string
  itemNumber: string
  designId: string
  onCheckoutComplete?: (branchId: string) => void
}

export function CheckoutDialog({
  open,
  onOpenChange,
  itemId,
  itemNumber,
  designId,
  onCheckoutComplete,
}: CheckoutDialogProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [branches, setBranches] = useState<Array<Branch>>([])
  const [selectedBranchId, setSelectedBranchId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [checkoutOption, setCheckoutOption] = useState<
    'existing' | 'new-eco' | 'workspace' | 'new-workspace'
  >('existing')
  const [createWorkspaceDialogOpen, setCreateWorkspaceDialogOpen] =
    useState(false)
  const [branchStatuses, setBranchStatuses] = useState<
    Map<string, CheckoutStatus>
  >(new Map())

  // Fetch available branches when dialog opens
  useEffect(() => {
    if (!open || !designId) return

    async function fetchBranches() {
      setLoading(true)
      try {
        const res = await apiFetch<{ data: { branches: Array<Branch> } }>(
          `/api/v1/designs/${designId}/branches`,
        )
        const activeBranches = res.data.branches.filter(
          (b) => !b.isArchived && !b.isLocked && b.branchType !== 'main',
        )
        setBranches(activeBranches)
      } catch {
        setBranches([])
      } finally {
        setLoading(false)
      }
    }

    fetchBranches()
  }, [open, designId])

  // Fetch checkout status for each branch
  useEffect(() => {
    if (!open || !itemId || branches.length === 0) return

    async function fetchBranchStatuses() {
      const statuses = new Map<string, CheckoutStatus>()

      await Promise.all(
        branches.map(async (branch) => {
          try {
            const response = await apiFetch<{
              data: { status: CheckoutStatus }
            }>(`/api/v1/items/${itemId}/checkout?branchId=${branch.id}`)
            statuses.set(branch.id, response.data.status)
          } catch {
            // Silently fail - item may not be on this branch
          }
        }),
      )

      setBranchStatuses(statuses)
    }

    fetchBranchStatuses()
  }, [open, itemId, branches])

  // Get the selected branch's checkout status
  const selectedBranchStatus = selectedBranchId
    ? branchStatuses.get(selectedBranchId)
    : undefined

  // Group branches by type
  const ecoBranches = branches.filter((b) => b.branchType === 'eco')
  const workspaceBranches = branches.filter((b) => b.branchType === 'workspace')

  // Handle checkout
  const handleCheckout = async () => {
    if (!selectedBranchId) {
      return
    }

    setIsSubmitting(true)
    try {
      await apiFetch(`/api/v1/items/${itemId}/checkout`, {
        method: 'POST',
        body: JSON.stringify({ branchId: selectedBranchId }),
      })

      const branch = branches.find((b) => b.id === selectedBranchId)
      showSuccess(
        'Item checked out',
        `${itemNumber} has been checked out to ${branch?.name || 'branch'}`,
      )

      onOpenChange(false)
      onCheckoutComplete?.(selectedBranchId)
    } catch (error) {
      handleError(error, { title: 'Failed to check out item' })
    } finally {
      setIsSubmitting(false)
    }
  }

  // Get display for selected branch
  const getSelectedBranchDisplay = () => {
    if (!selectedBranchId) return 'Select a branch'
    const branch = branches.find((b) => b.id === selectedBranchId)
    return branch?.name || 'Unknown branch'
  }

  // Handle workspace creation and automatic checkout
  const handleWorkspaceCreated = async (
    workspaceId: string,
    workspaceName: string,
  ) => {
    setCreateWorkspaceDialogOpen(false)

    // Automatically select the new workspace and check out
    setSelectedBranchId(workspaceId)
    setIsSubmitting(true)
    try {
      await apiFetch(`/api/v1/items/${itemId}/checkout`, {
        method: 'POST',
        body: JSON.stringify({ branchId: workspaceId }),
      })

      showSuccess(
        'Workspace created and item checked out',
        `${itemNumber} has been checked out to ${workspaceName}`,
      )

      onOpenChange(false)
      onCheckoutComplete?.(workspaceId)
    } catch (error) {
      handleError(error, { title: 'Failed to check out item' })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Check Out Item
          </DialogTitle>
          <DialogDescription>
            Check out <strong>{itemNumber}</strong> to a branch for editing.
            Released items must be edited on an ECO or workspace branch.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              <span className="ml-2 text-slate-500">Loading branches...</span>
            </div>
          ) : (
            <>
              {/* Checkout options */}
              <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Checkout to:
                </label>

                {/* Option: Existing ECO */}
                {ecoBranches.length > 0 && (
                  <div
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      checkoutOption === 'existing'
                        ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20'
                        : 'border-slate-300 dark:border-slate-700 hover:border-slate-300'
                    }`}
                    onClick={() => setCheckoutOption('existing')}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="outline" className="text-xs">
                        ECO
                      </Badge>
                      <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                        Existing Change Order
                      </span>
                    </div>
                    {checkoutOption === 'existing' && (
                      <Select
                        value={selectedBranchId}
                        onValueChange={setSelectedBranchId}
                      >
                        <SelectTrigger className="w-full mt-2">
                          <SelectValue placeholder="Select ECO branch">
                            {getSelectedBranchDisplay()}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectLabel>Active ECOs</SelectLabel>
                            {ecoBranches.map((branch) => {
                              const status = branchStatuses.get(branch.id)
                              return (
                                <SelectItem key={branch.id} value={branch.id}>
                                  <div className="flex items-center gap-2">
                                    <span>{branch.name}</span>
                                    {status?.isCheckedOut && (
                                      <Badge
                                        variant="warning"
                                        className="text-xs px-1 py-0"
                                      >
                                        <Lock className="w-3 h-3 mr-1" />
                                        Locked
                                      </Badge>
                                    )}
                                  </div>
                                </SelectItem>
                              )
                            })}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}

                {/* Option: Existing Workspace */}
                {workspaceBranches.length > 0 && (
                  <div
                    className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                      checkoutOption === 'workspace'
                        ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20'
                        : 'border-slate-300 dark:border-slate-700 hover:border-slate-300'
                    }`}
                    onClick={() => setCheckoutOption('workspace')}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <Badge variant="secondary" className="text-xs">
                        WS
                      </Badge>
                      <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                        My Workspace
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Personal sandbox for drafting changes
                    </p>
                    {checkoutOption === 'workspace' &&
                      workspaceBranches.length > 0 && (
                        <Select
                          value={selectedBranchId}
                          onValueChange={setSelectedBranchId}
                        >
                          <SelectTrigger className="w-full mt-2">
                            <SelectValue placeholder="Select workspace">
                              {getSelectedBranchDisplay()}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              <SelectLabel>Workspaces</SelectLabel>
                              {workspaceBranches.map((branch) => {
                                const status = branchStatuses.get(branch.id)
                                return (
                                  <SelectItem key={branch.id} value={branch.id}>
                                    <div className="flex items-center gap-2">
                                      <span>{branch.name}</span>
                                      {status?.isCheckedOut && (
                                        <Badge
                                          variant="warning"
                                          className="text-xs px-1 py-0"
                                        >
                                          <Lock className="w-3 h-3 mr-1" />
                                          Locked
                                        </Badge>
                                      )}
                                    </div>
                                  </SelectItem>
                                )
                              })}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      )}
                  </div>
                )}

                {/* Option: Create New Workspace */}
                <div
                  className={`p-3 border rounded-lg cursor-pointer transition-colors ${
                    checkoutOption === 'new-workspace'
                      ? 'border-cyan-500 bg-cyan-50 dark:bg-cyan-900/20'
                      : 'border-slate-300 dark:border-slate-700 hover:border-slate-300'
                  }`}
                  onClick={() => {
                    setCheckoutOption('new-workspace')
                    setCreateWorkspaceDialogOpen(true)
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Plus className="h-4 w-4 text-cyan-600" />
                    <span className="font-medium text-sm text-slate-900 dark:text-slate-100">
                      Create New Workspace
                    </span>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Start a new private workspace for this design
                  </p>
                </div>

                {/* Warning when selected branch has existing checkout */}
                {selectedBranchId && selectedBranchStatus?.isCheckedOut && (
                  <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
                      <div className="text-sm">
                        <p className="font-medium text-amber-800 dark:text-amber-200">
                          Already checked out
                        </p>
                        <p className="text-amber-700 dark:text-amber-300 mt-1">
                          This item is already checked out on this branch by{' '}
                          <strong>
                            {selectedBranchStatus.checkedOutBy?.name ||
                              selectedBranchStatus.checkedOutBy?.email ||
                              'another user'}
                          </strong>
                          . Proceeding will override the existing checkout.
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* No branches available */}
                {ecoBranches.length === 0 && workspaceBranches.length === 0 && (
                  <div className="p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      No active ECO or workspace branches available for this
                      design. Create a Change Order first, then check out items
                      to it.
                    </p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleCheckout}
            disabled={
              !selectedBranchId ||
              isSubmitting ||
              loading ||
              checkoutOption === 'new-workspace'
            }
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Checking out...
              </>
            ) : (
              <>
                <GitBranch className="h-4 w-4 mr-2" />
                Check Out
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Create Workspace Dialog (nested) */}
      <CreateWorkspaceDialog
        open={createWorkspaceDialogOpen}
        onOpenChange={setCreateWorkspaceDialogOpen}
        designId={designId}
        onSuccess={handleWorkspaceCreated}
      />
    </Dialog>
  )
}
