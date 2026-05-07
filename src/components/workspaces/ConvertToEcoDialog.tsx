import { useState } from 'react'
import { FileBox, Loader2 } from 'lucide-react'
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

interface ConvertToEcoDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspaceId: string
  workspaceName: string
  itemCount: number
  onSuccess?: (ecoId: string, ecoNumber: string) => void
}

export function ConvertToEcoDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  itemCount,
  onSuccess,
}: ConvertToEcoDialogProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [ecoTitle, setEcoTitle] = useState('')
  const [ecoDescription, setEcoDescription] = useState('')
  const [changeType, setChangeType] = useState<
    'ECO' | 'ECN' | 'MCO' | 'Deviation'
  >('ECO')
  const [deleteWorkspace, setDeleteWorkspace] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleConvert = async () => {
    if (!ecoTitle.trim()) {
      handleError(new Error('ECO title is required'), {
        title: 'Validation Error',
      })
      return
    }

    setIsSubmitting(true)
    try {
      const response = await apiFetch<{
        data: {
          ecoId: string
          ecoNumber: string
          itemsConverted: number
          workspaceDeleted: boolean
        }
      }>(`/api/v1/workspaces/${workspaceId}/convert-to-eco`, {
        method: 'POST',
        body: JSON.stringify({
          ecoTitle: ecoTitle.trim(),
          ecoDescription: ecoDescription.trim(),
          changeType,
          deleteWorkspace,
        }),
      })

      showSuccess(
        'Workspace converted to ECO',
        `Created ${response.data.ecoNumber} with ${response.data.itemsConverted} item${response.data.itemsConverted !== 1 ? 's' : ''}`,
      )

      onOpenChange(false)
      setEcoTitle('')
      setEcoDescription('')
      setDeleteWorkspace(false)
      onSuccess?.(response.data.ecoId, response.data.ecoNumber)
    } catch (error) {
      handleError(error, { title: 'Failed to convert workspace to ECO' })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileBox className="h-5 w-5" />
            Convert to Engineering Change Order
          </DialogTitle>
          <DialogDescription>
            Create a new ECO from workspace <strong>{workspaceName}</strong>.
            This will move {itemCount} item{itemCount !== 1 ? 's' : ''} to
            formal change control.
          </DialogDescription>
        </DialogHeader>

        <div className="py-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="eco-title">ECO Title *</Label>
            <Input
              id="eco-title"
              placeholder="e.g., Update power supply design"
              value={ecoTitle}
              onChange={(e) => setEcoTitle(e.target.value)}
              disabled={isSubmitting}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="eco-description">Description</Label>
            <Textarea
              id="eco-description"
              placeholder="Describe the changes included in this ECO..."
              value={ecoDescription}
              onChange={(e) => setEcoDescription(e.target.value)}
              disabled={isSubmitting}
              rows={4}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="change-type">Change Type</Label>
            <Select
              value={changeType}
              onValueChange={(value) =>
                setChangeType(value as 'ECO' | 'ECN' | 'MCO' | 'Deviation')
              }
              disabled={isSubmitting}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ECO">
                  ECO - Engineering Change Order
                </SelectItem>
                <SelectItem value="ECN">
                  ECN - Engineering Change Notice
                </SelectItem>
                <SelectItem value="MCO">
                  MCO - Manufacturing Change Order
                </SelectItem>
                <SelectItem value="Deviation">Deviation</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center space-x-2 pt-2">
            <Checkbox
              id="delete-workspace"
              checked={deleteWorkspace}
              onCheckedChange={(checked) =>
                setDeleteWorkspace(checked === true)
              }
              disabled={isSubmitting}
            />
            <label
              htmlFor="delete-workspace"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Delete workspace after conversion
            </label>
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
            onClick={handleConvert}
            disabled={!ecoTitle.trim() || isSubmitting}
          >
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Converting...
              </>
            ) : (
              <>
                <FileBox className="h-4 w-4 mr-2" />
                Convert to ECO
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
