import { useEffect, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { AlertCircle, GitBranch, Plus } from 'lucide-react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  LoadingSpinner,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'

interface ChangeOrder {
  id: string
  itemNumber: string
  name: string
  state: string
}

interface EcoCheckoutDialogProps {
  isOpen: boolean
  onClose: () => void
  itemId: string
  itemNumber: string
  designId?: string
  designCode?: string
}

export function EcoCheckoutDialog({
  isOpen,
  onClose,
  itemId,
  itemNumber,
  designCode,
}: EcoCheckoutDialogProps) {
  const router = useRouter()
  const { handleError, showSuccess } = useErrorHandler()
  const [changeOrders, setChangeOrders] = useState<Array<ChangeOrder>>([])
  const [selectedEcoId, setSelectedEcoId] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetchActiveEcos() {
      if (!isOpen) return

      setIsLoading(true)
      setError(null)
      try {
        const response = await apiFetch<{
          data: { changeOrders: Array<ChangeOrder> }
        }>('/api/change-orders/editable')
        const ecos = response.data.changeOrders
        setChangeOrders(ecos)

        // Auto-select if only one ECO
        if (ecos.length === 1) {
          setSelectedEcoId(ecos[0].id)
        }
      } catch {
        setError('Unable to load active change orders')
      } finally {
        setIsLoading(false)
      }
    }

    fetchActiveEcos()
  }, [isOpen])

  const handleCheckout = async () => {
    if (!selectedEcoId) {
      setError('Please select a change order')
      return
    }

    setIsSubmitting(true)
    setError(null)
    try {
      await apiFetch(`/api/change-orders/${selectedEcoId}/checkout`, {
        method: 'POST',
        body: JSON.stringify({ itemId }),
      })

      showSuccess(
        'Item checked out',
        `${itemNumber} has been checked out to the selected ECO`,
      )
      onClose()
      router.invalidate()
    } catch (err) {
      handleError(err, { title: 'Failed to checkout item' })
      setError('Failed to checkout item to ECO')
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleCreateNewEco = () => {
    onClose()
    router.navigate({ to: '/change-orders', search: { createNew: true } })
  }

  const selectedEco = changeOrders.find((eco) => eco.id === selectedEcoId)

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="h-5 w-5" />
            Edit in Change Order
          </DialogTitle>
          <DialogDescription>
            Check out <strong>{itemNumber}</strong> to a change order for
            editing. This will create a branch for your changes.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300"
            >
              <AlertCircle
                className="h-4 w-4 flex-shrink-0"
                aria-hidden="true"
              />
              <span className="text-sm">{error}</span>
            </div>
          )}

          {designCode && (
            <div className="text-sm text-slate-500 dark:text-slate-400">
              This will create or use a branch on design{' '}
              <strong>{designCode}</strong>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-medium">Select Change Order</label>
            <div className="relative">
              <Select
                value={selectedEcoId}
                onValueChange={setSelectedEcoId}
                disabled={isLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select an ECO" />
                </SelectTrigger>
                <SelectContent>
                  {changeOrders.map((eco) => (
                    <SelectItem key={eco.id} value={eco.id}>
                      <span className="font-medium">{eco.itemNumber}</span>
                      <span className="text-slate-500 ml-2">- {eco.name}</span>
                    </SelectItem>
                  ))}
                  {changeOrders.length === 0 && !isLoading && (
                    <div className="p-2 text-sm text-slate-500 text-center">
                      No active change orders
                    </div>
                  )}
                </SelectContent>
              </Select>
              {isLoading && (
                <div className="absolute right-8 top-1/2 -translate-y-1/2">
                  <LoadingSpinner size="sm" />
                </div>
              )}
            </div>
          </div>

          {selectedEco && designCode && (
            <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-3 text-sm">
              <p className="text-slate-600 dark:text-slate-300">This will:</p>
              <ul className="mt-2 space-y-1 text-slate-500 dark:text-slate-400 list-disc list-inside">
                <li>
                  Create branch <strong>eco/{selectedEco.itemNumber}</strong> on{' '}
                  {designCode}
                </li>
                <li>Add {itemNumber} to the change order</li>
                <li>Allow you to make and save changes</li>
              </ul>
            </div>
          )}

          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span>Or</span>
            <Button
              variant="link"
              size="sm"
              onClick={handleCreateNewEco}
              className="p-0 h-auto"
            >
              <Plus className="h-3 w-3 mr-1" />
              Create a new Change Order
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            onClick={handleCheckout}
            disabled={!selectedEcoId || isSubmitting}
          >
            {isSubmitting ? 'Checking out...' : 'Checkout'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
