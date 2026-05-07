import { useState } from 'react'
import { GitBranch, Loader2 } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

interface CreateWorkspaceDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  designId: string
  designName?: string
  onSuccess?: (workspaceId: string, workspaceName: string) => void
}

export function CreateWorkspaceDialog({
  open,
  onOpenChange,
  designId,
  designName,
  onSuccess,
}: CreateWorkspaceDialogProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [workspaceName, setWorkspaceName] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleCreate = async () => {
    if (!workspaceName.trim()) {
      handleError(new Error('Workspace name is required'), {
        title: 'Validation Error',
      })
      return
    }

    setIsSubmitting(true)
    try {
      const response = await apiFetch<{
        data: { workspaceId: string; branchName: string }
      }>('/api/v1/workspaces', {
        method: 'POST',
        body: JSON.stringify({
          designId,
          workspaceName: workspaceName.trim(),
        }),
      })

      showSuccess(
        'Workspace created',
        `Workspace "${workspaceName}" has been created successfully`,
      )

      onOpenChange(false)
      setWorkspaceName('')
      onSuccess?.(response.data.workspaceId, response.data.branchName)
    } catch (error) {
      handleError(error, { title: 'Failed to create workspace' })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isSubmitting) {
      e.preventDefault()
      handleCreate()
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Create Workspace
          </DialogTitle>
          <DialogDescription>
            Create a new workspace for{' '}
            <strong>{designName || 'this design'}</strong>. Workspaces are
            private branches where you can draft changes before creating an ECO.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="workspace-name">Workspace Name</Label>
            <Input
              id="workspace-name"
              placeholder="e.g., my-feature, bug-fix, draft-changes"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isSubmitting}
              autoFocus
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Use lowercase letters, numbers, and hyphens only
            </p>
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={!workspaceName.trim() || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <GitBranch className="h-4 w-4 mr-2" />
                Create Workspace
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
