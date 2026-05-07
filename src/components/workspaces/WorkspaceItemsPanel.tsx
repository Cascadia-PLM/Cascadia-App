import { useCallback, useEffect, useState } from 'react'
import {
  FolderTree,
  GitBranch,
  Loader2,
  Plus,
  Table as TableIcon,
  X,
} from 'lucide-react'
import { Link } from '@tanstack/react-router'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'

interface WorkspaceItem {
  id: string
  itemId: string
  itemMasterId: string
  itemNumber: string
  itemName: string
  itemType: string
  revision: string
  state: string
  changeType: 'added' | 'modified' | 'deleted'
  checkedOutBy: string | null
  checkedOutAt: Date | null
}

interface WorkspaceItemsPanelProps {
  workspaceId: string
  workspaceName: string
  designId: string
  readOnly?: boolean
  onItemsChange?: () => void
}

const changeTypeColor: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  added: 'success',
  modified: 'default',
  deleted: 'destructive',
}

const itemTypeIcons: Record<string, string> = {
  Part: '🔧',
  Document: '📄',
  Requirement: '📋',
  Task: '✓',
  ChangeOrder: '🔄',
}

export function WorkspaceItemsPanel({
  workspaceId,
  readOnly = false,
  onItemsChange,
}: WorkspaceItemsPanelProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const [activeTab, setActiveTab] = useState<'table' | 'tree'>('table')
  const [loading, setLoading] = useState(true)
  const [items, setItems] = useState<Array<WorkspaceItem>>([])
  const [refreshKey, setRefreshKey] = useState(0)

  // Fetch workspace items
  const fetchItems = useCallback(async () => {
    setLoading(true)
    try {
      const response = await apiFetch<{
        data: { items: Array<WorkspaceItem> }
      }>(`/api/v1/workspaces/${workspaceId}/items`)
      setItems(response.data.items)
    } catch (error) {
      handleError(error, { title: 'Failed to load items' })
      setItems([])
    } finally {
      setLoading(false)
    }
  }, [workspaceId, handleError])

  // Initial fetch
  useEffect(() => {
    fetchItems()
  }, [fetchItems, refreshKey])

  // Handle remove from workspace (undo checkout)
  const handleRemove = async (itemId: string, itemNumber: string) => {
    try {
      await apiFetch(`/api/v1/items/${itemId}/cancel-checkout`, {
        method: 'POST',
        body: JSON.stringify({ branchId: workspaceId }),
      })

      showSuccess('Item removed', `${itemNumber} removed from workspace`)
      setRefreshKey((k) => k + 1)
      onItemsChange?.()
    } catch (error) {
      handleError(error, { title: 'Failed to remove item' })
    }
  }

  // Get count statistics
  const totalItems = items.length
  const addedCount = items.filter((i) => i.changeType === 'added').length
  const modifiedCount = items.filter((i) => i.changeType === 'modified').length
  const deletedCount = items.filter((i) => i.changeType === 'deleted').length

  if (loading) {
    return (
      <Card>
        <CardContent className="py-12">
          <div className="flex items-center justify-center">
            <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Workspace Items
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{totalItems} total</Badge>
            {addedCount > 0 && (
              <Badge variant="success">{addedCount} added</Badge>
            )}
            {modifiedCount > 0 && (
              <Badge variant="default">{modifiedCount} modified</Badge>
            )}
            {deletedCount > 0 && (
              <Badge variant="destructive">{deletedCount} deleted</Badge>
            )}
          </div>
        </div>
        {!readOnly && (
          <Button size="sm" disabled>
            <Plus className="h-4 w-4 mr-2" />
            Add Item (Coming Soon)
          </Button>
        )}
      </div>

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'table' | 'tree')}
      >
        <TabsList>
          <TabsTrigger value="table" className="gap-2">
            <TableIcon className="h-4 w-4" />
            Table View
          </TabsTrigger>
          <TabsTrigger value="tree" className="gap-2" disabled>
            <FolderTree className="h-4 w-4" />
            Tree View (Coming Soon)
          </TabsTrigger>
        </TabsList>

        {/* Table View Tab */}
        <TabsContent value="table" className="mt-4">
          <Card>
            <CardContent className="pt-6">
              {items.length === 0 ? (
                <div className="text-center py-8 border rounded-lg">
                  <GitBranch className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
                  <p className="text-slate-500 dark:text-slate-400">
                    No items in this workspace yet
                  </p>
                  <p className="text-sm text-slate-400 dark:text-slate-500 mt-2">
                    Check out items to this workspace to start working on them
                  </p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item Number</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Change Type</TableHead>
                      <TableHead>State</TableHead>
                      <TableHead>Rev</TableHead>
                      {!readOnly && (
                        <TableHead className="text-right">Actions</TableHead>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((item) => (
                      <TableRow key={item.id}>
                        <TableCell className="font-medium">
                          <Link
                            to={
                              `/${item.itemType.toLowerCase()}s/${item.itemId}` as any
                            }
                            className="text-blue-600 hover:underline dark:text-blue-400"
                          >
                            {item.itemNumber}
                          </Link>
                        </TableCell>
                        <TableCell className="text-slate-600 dark:text-slate-400">
                          {item.itemName || '-'}
                        </TableCell>
                        <TableCell>
                          <Badge variant="secondary">
                            <span className="mr-1">
                              {itemTypeIcons[item.itemType] || '📦'}
                            </span>
                            {item.itemType}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant={changeTypeColor[item.changeType]}>
                            {item.changeType}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm">{item.state}</span>
                        </TableCell>
                        <TableCell>
                          <span className="text-sm font-mono">
                            {item.revision}
                          </span>
                        </TableCell>
                        {!readOnly && (
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                  handleRemove(item.itemId, item.itemNumber)
                                }
                                title="Remove from workspace"
                              >
                                <X className="h-4 w-4 text-red-600" />
                              </Button>
                            </div>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tree View Tab (placeholder) */}
        <TabsContent value="tree" className="mt-4">
          <Card>
            <CardContent className="py-12 text-center">
              <FolderTree className="h-12 w-12 mx-auto mb-4 opacity-50 text-slate-400" />
              <p className="text-slate-500 dark:text-slate-400">
                Tree view coming soon
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
