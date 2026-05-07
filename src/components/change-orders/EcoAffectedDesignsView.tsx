import { useCallback, useEffect, useState } from 'react'
import { FolderTree, Loader2, Plus } from 'lucide-react'
import { EcoDesignStructureTree } from './EcoDesignStructureTree'
import { AddToEcoDialog } from './AddToEcoDialog'
import { ParentPropagationDialog } from './ParentPropagationDialog'
import { AddDesignToEcoDialog } from './AddDesignToEcoDialog'
import type { BOMTreeNode } from './EcoTreeTable'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'
import { Button, Card, CardContent } from '@/components/ui'

interface EcoDesign {
  id: string
  designId: string
  designName: string
  branchId: string | null
  mergeStatus: string
  itemsAffected: number
}

interface EcoAffectedDesignsViewProps {
  changeOrderId: string
  changeOrderState: string
  readOnly?: boolean
}

export function EcoAffectedDesignsView({
  changeOrderId,
  changeOrderState,
  readOnly = false,
}: EcoAffectedDesignsViewProps) {
  const { alert } = useAlertDialog()
  const [loading, setLoading] = useState(true)
  const [designs, setDesigns] = useState<Array<EcoDesign>>([])
  const [refreshKey, setRefreshKey] = useState(0)

  // Dialog states
  const [addToEcoDialogOpen, setAddToEcoDialogOpen] = useState(false)
  const [parentPropagationDialogOpen, setParentPropagationDialogOpen] =
    useState(false)
  const [addDesignDialogOpen, setAddDesignDialogOpen] = useState(false)
  const [selectedNode, setSelectedNode] = useState<BOMTreeNode | null>(null)
  const [selectedDesignId, setSelectedDesignId] = useState<string | null>(null)

  // Determine if editing is allowed
  const isEditable = !readOnly && changeOrderState === 'Draft'

  const fetchDesigns = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch<{ data: { designs: Array<EcoDesign> } }>(
        `/api/v1/change-orders/${changeOrderId}/designs`,
      )
      setDesigns(response.data.designs)
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to load affected designs.',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }, [changeOrderId, alert])

  useEffect(() => {
    fetchDesigns()
  }, [fetchDesigns, refreshKey])

  // Handle adding an item to ECO from tree
  const handleAddToEco = async (node: BOMTreeNode, designId: string) => {
    setSelectedNode(node)
    setSelectedDesignId(designId)

    // Check if item has released ancestors that need to be included
    try {
      const response = await apiFetch<{
        data: {
          ancestors: Array<{
            itemId: string
            state: string
          }>
          releasedCount: number
        }
      }>(
        `/api/v1/change-orders/${changeOrderId}/items/${node.itemId}/ancestors?designId=${designId}`,
      )

      if (response.data.releasedCount > 0) {
        // Show parent propagation dialog
        setParentPropagationDialogOpen(true)
      } else {
        // No released parents, show simple add dialog
        setAddToEcoDialogOpen(true)
      }
    } catch {
      // Fall back to simple add dialog
      setAddToEcoDialogOpen(true)
    }
  }

  // Handle successful add
  const handleAddSuccess = () => {
    setAddToEcoDialogOpen(false)
    setParentPropagationDialogOpen(false)
    setSelectedNode(null)
    setSelectedDesignId(null)
    setRefreshKey((k) => k + 1)
    fetchDesigns()
  }

  // Handle successful design add
  const handleDesignAdded = () => {
    setAddDesignDialogOpen(false)
    fetchDesigns()
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header with actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FolderTree className="h-5 w-5 text-slate-500" />
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Affected Designs
          </h2>
          <span className="text-sm text-slate-500">
            ({designs.length} design{designs.length !== 1 ? 's' : ''})
          </span>
        </div>
        {isEditable && (
          <Button onClick={() => setAddDesignDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Design
          </Button>
        )}
      </div>

      {/* Designs list */}
      {designs.length > 0 ? (
        <div className="space-y-4">
          {designs.map((design) => (
            <EcoDesignStructureTree
              key={`${design.designId}-${refreshKey}`}
              designId={design.designId}
              designName={design.designName}
              changeOrderId={changeOrderId}
              readOnly={!isEditable}
              onAddToEco={handleAddToEco}
            />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="py-12">
            <div className="text-center text-slate-500 dark:text-slate-400">
              <FolderTree className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p className="mb-4">No designs are affected by this ECO yet.</p>
              {isEditable && (
                <Button onClick={() => setAddDesignDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Add Design
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Add to ECO Dialog (simple, single item) */}
      {selectedNode && selectedDesignId && (
        <AddToEcoDialog
          open={addToEcoDialogOpen}
          onOpenChange={setAddToEcoDialogOpen}
          changeOrderId={changeOrderId}
          item={selectedNode}
          onSuccess={handleAddSuccess}
        />
      )}

      {/* Parent Propagation Dialog */}
      {selectedNode && selectedDesignId && (
        <ParentPropagationDialog
          open={parentPropagationDialogOpen}
          onOpenChange={setParentPropagationDialogOpen}
          changeOrderId={changeOrderId}
          designId={selectedDesignId}
          targetItem={selectedNode}
          onSuccess={handleAddSuccess}
        />
      )}

      {/* Add Design Dialog */}
      <AddDesignToEcoDialog
        open={addDesignDialogOpen}
        onOpenChange={setAddDesignDialogOpen}
        changeOrderId={changeOrderId}
        existingDesignIds={designs.map((d) => d.designId)}
        onSuccess={handleDesignAdded}
      />
    </div>
  )
}
