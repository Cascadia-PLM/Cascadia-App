import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, Link as LinkIcon, Plus, Trash2 } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import type { DataGridColumn } from '@/components/ui/DataGrid'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  DataGrid,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { apiFetch } from '@/lib/api/client'

interface SatisfiedRequirement {
  id: string
  itemNumber: string
  name: string | null
  priority: string | null
  verificationStatus: string | null
  relationshipId: string
}

interface RequirementSearchResult {
  id: string
  itemNumber: string
  name: string | null
  state: string
  revision: string
  priority?: string
}

interface RequirementLinkingPanelProps {
  /** The item ID to show/manage requirements for */
  itemId: string
  /** The item's design ID for filtering requirements */
  designId?: string
  /** Whether the panel is read-only */
  readOnly?: boolean
  /** Callback when requirements are updated */
  onUpdate?: () => void
}

/**
 * Panel for linking requirements to a Part or Document.
 * Shows what requirements an item satisfies and allows adding/removing links.
 */
export function RequirementLinkingPanel({
  itemId,
  designId,
  readOnly = false,
  onUpdate,
}: RequirementLinkingPanelProps) {
  const { alert, confirm } = useAlertDialog()
  const [requirements, setRequirements] = useState<Array<SatisfiedRequirement>>(
    [],
  )
  const [loading, setLoading] = useState(true)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<
    Array<RequirementSearchResult>
  >([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [adding, setAdding] = useState(false)

  // Load requirements satisfied by this item
  const loadRequirements = useCallback(async () => {
    try {
      const response = await apiFetch<{
        data: { requirements: Array<SatisfiedRequirement> }
      }>(`/api/items/${itemId}/satisfied-requirements`)
      setRequirements(response.data.requirements)
    } catch {
      // Failed to load requirements
    } finally {
      setLoading(false)
    }
  }, [itemId])

  useEffect(() => {
    loadRequirements()
  }, [loadRequirements])

  // Search requirements
  useEffect(() => {
    if (!addDialogOpen || searchQuery.length < 2) {
      setSearchResults([])
      return
    }

    const timer = setTimeout(async () => {
      setSearchLoading(true)
      try {
        // Search for requirements
        const params = new URLSearchParams({
          q: searchQuery,
          types: 'Requirement',
          limit: '20',
        })
        if (designId) {
          params.set('designId', designId)
        }

        const response = await apiFetch<{
          data: { items: Array<RequirementSearchResult> }
        }>(`/api/items/search?${params}`)

        // Filter out already linked requirements
        const linkedIds = new Set(requirements.map((r) => r.id))
        const filtered = response.data.items.filter((r) => !linkedIds.has(r.id))
        setSearchResults(filtered)
      } catch {
        setSearchResults([])
      } finally {
        setSearchLoading(false)
      }
    }, 300)

    return () => clearTimeout(timer)
  }, [searchQuery, addDialogOpen, designId, requirements])

  const handleRemoveLink = (requirementId: string) => {
    confirm({
      title: 'Remove Requirement Link',
      description:
        'Are you sure you want to remove this satisfaction link? The item will no longer be recorded as satisfying this requirement.',
      actionLabel: 'Remove',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/requirements/${requirementId}/satisfy`, {
            method: 'DELETE',
            body: JSON.stringify({ itemId }),
          })
          await loadRequirements()
          onUpdate?.()
        } catch {
          alert({
            title: 'Error',
            description: 'Failed to remove requirement link',
            variant: 'destructive',
          })
        }
      },
    })
  }

  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds)
    if (newSelected.has(id)) {
      newSelected.delete(id)
    } else {
      newSelected.add(id)
    }
    setSelectedIds(newSelected)
  }

  const handleAddSelected = async () => {
    if (selectedIds.size === 0) return

    setAdding(true)
    try {
      // Link each selected requirement
      for (const requirementId of selectedIds) {
        await apiFetch(`/api/requirements/${requirementId}/satisfy`, {
          method: 'POST',
          body: JSON.stringify({ itemIds: [itemId] }),
        })
      }
      await loadRequirements()
      setAddDialogOpen(false)
      setSelectedIds(new Set())
      setSearchQuery('')
      onUpdate?.()
    } catch {
      alert({
        title: 'Error',
        description: 'Failed to link requirements',
        variant: 'destructive',
      })
    } finally {
      setAdding(false)
    }
  }

  const priorityVariant = (priority: string | null) => {
    const variants: Record<
      string,
      'default' | 'secondary' | 'success' | 'warning' | 'destructive'
    > = {
      MustHave: 'destructive',
      ShouldHave: 'warning',
      CouldHave: 'default',
      WontHave: 'secondary',
    }
    return variants[priority || ''] || 'secondary'
  }

  const verificationStatusVariant = (status: string | null) => {
    const variants: Record<
      string,
      'default' | 'secondary' | 'success' | 'warning' | 'destructive'
    > = {
      NotStarted: 'secondary',
      InProgress: 'default',
      Passed: 'success',
      Failed: 'destructive',
      Waived: 'secondary',
    }
    return variants[status || ''] || 'secondary'
  }

  const columns: Array<DataGridColumn<SatisfiedRequirement>> = useMemo(
    () => [
      {
        id: 'itemNumber',
        header: 'Requirement',
        accessorKey: 'itemNumber',
        enableSorting: true,
        cell: ({ row }) => (
          <Link
            to={`/requirements/${row.original.id}` as any}
            className="font-medium text-cyan-600 hover:text-cyan-700 hover:underline flex items-center gap-1"
          >
            {row.original.itemNumber}
            <ExternalLink className="h-3 w-3" />
          </Link>
        ),
      },
      {
        id: 'name',
        header: 'Name',
        accessorKey: 'name',
        enableSorting: true,
        cell: ({ getValue }) => (
          <span className="text-slate-600 dark:text-slate-400">
            {(getValue() as string | null) || '-'}
          </span>
        ),
      },
      {
        id: 'priority',
        header: 'Priority',
        accessorKey: 'priority',
        enableSorting: true,
        meta: { width: '100px' },
        cell: ({ getValue }) => {
          const priority = getValue() as string | null
          if (!priority) return '-'
          return <Badge variant={priorityVariant(priority)}>{priority}</Badge>
        },
      },
      {
        id: 'verificationStatus',
        header: 'Verification',
        accessorKey: 'verificationStatus',
        enableSorting: true,
        meta: { width: '110px' },
        cell: ({ getValue }) => {
          const status = getValue() as string | null
          if (!status) return '-'
          return (
            <Badge variant={verificationStatusVariant(status)}>{status}</Badge>
          )
        },
      },
      ...(readOnly
        ? []
        : ([
            {
              id: 'actions',
              header: '',
              enableSorting: false,
              meta: { width: '50px', align: 'center' as const },
              cell: ({ row }) => (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveLink(row.original.id)}
                  className="h-8 w-8 p-0"
                  title="Remove link"
                >
                  <Trash2 className="h-4 w-4 text-red-600" />
                </Button>
              ),
            },
          ] as Array<DataGridColumn<SatisfiedRequirement>>)),
    ],
    [readOnly],
  )

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon className="h-5 w-5" />
            Requirements Satisfied
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-slate-500">Loading requirements...</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <LinkIcon className="h-5 w-5" />
                Requirements Satisfied
              </CardTitle>
              <CardDescription>
                Requirements that this item helps satisfy
              </CardDescription>
            </div>
            {!readOnly && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setAddDialogOpen(true)}
              >
                <Plus className="h-4 w-4 mr-1" />
                Link Requirement
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {requirements.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-slate-500 mb-4">
                No requirements linked yet
              </p>
              {!readOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setAddDialogOpen(true)}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Link First Requirement
                </Button>
              )}
            </div>
          ) : (
            <DataGrid
              data={requirements}
              columns={columns}
              getRowId={(row) => row.id}
              enablePagination={requirements.length > 10}
              defaultPageSize={10}
              emptyMessage="No requirements linked"
            />
          )}
        </CardContent>
      </Card>

      <Dialog open={addDialogOpen} onOpenChange={setAddDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Link Requirements</DialogTitle>
            <DialogDescription>
              Search for requirements to link to this item. This records that
              the item helps satisfy the selected requirements.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              placeholder="Search requirements by number or name..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              autoFocus
            />

            {searchLoading ? (
              <p className="text-sm text-slate-500">Searching...</p>
            ) : searchResults.length > 0 ? (
              <div className="border rounded-lg divide-y max-h-80 overflow-auto">
                {searchResults.map((req) => (
                  <div
                    key={req.id}
                    className={`p-3 flex items-center justify-between hover:bg-slate-50 dark:hover:bg-slate-900 cursor-pointer ${
                      selectedIds.has(req.id)
                        ? 'bg-cyan-50 dark:bg-cyan-950'
                        : ''
                    }`}
                    onClick={() => toggleSelection(req.id)}
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{req.itemNumber}</span>
                        <Badge variant="outline" className="text-xs">
                          {req.revision}
                        </Badge>
                        {req.priority && (
                          <Badge
                            variant={priorityVariant(req.priority)}
                            className="text-xs"
                          >
                            {req.priority}
                          </Badge>
                        )}
                      </div>
                      {req.name && (
                        <p className="text-sm text-slate-500 truncate">
                          {req.name}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-2">
                      <Badge variant="secondary" className="text-xs">
                        {req.state}
                      </Badge>
                      {selectedIds.has(req.id) && (
                        <Badge variant="default">Selected</Badge>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : searchQuery.length >= 2 ? (
              <p className="text-sm text-slate-500">No requirements found</p>
            ) : (
              <p className="text-sm text-slate-500">
                Type at least 2 characters to search
              </p>
            )}

            <div className="flex items-center justify-between pt-4 border-t">
              <span className="text-sm text-slate-500">
                {selectedIds.size} requirement
                {selectedIds.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setAddDialogOpen(false)
                    setSelectedIds(new Set())
                    setSearchQuery('')
                  }}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={selectedIds.size === 0 || adding}
                  onClick={handleAddSelected}
                >
                  {adding
                    ? 'Linking...'
                    : `Link ${selectedIds.size} Requirement${selectedIds.size !== 1 ? 's' : ''}`}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
