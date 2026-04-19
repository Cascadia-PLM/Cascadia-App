import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Database,
  FileJson,
  Loader2,
  Package,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import type { ChangeEvent, DragEvent } from 'react'
import type { CatalogEntryWithCategory } from '@/lib/services/CatalogService'
import { PageContainer } from '@/components/layout'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  Input,
  Label,
  Select,
  Textarea,
} from '@/components/ui'

export const Route = createFileRoute('/admin/component-catalog')({
  component: ComponentCatalogPage,
})

interface Category {
  id: string
  name: string
  slug: string
  parentId: string | null
  sortOrder: number | null
}

function ComponentCatalogPage() {
  const [categories, setCategories] = useState<Array<Category>>([])
  const [entries, setEntries] = useState<Array<CatalogEntryWithCategory>>([])
  const [totalEntries, setTotalEntries] = useState(0)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  )
  const [entryTypeFilter, setEntryTypeFilter] = useState<string>('all')
  const [page, setPage] = useState(0)
  const pageSize = 25

  // Dialog state
  const [showEntryDialog, setShowEntryDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showCategoryDialog, setShowCategoryDialog] = useState(false)
  const [editingEntry, setEditingEntry] =
    useState<CatalogEntryWithCategory | null>(null)

  const loadCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/component-catalog/categories')
      if (res.ok) {
        const data = await res.json()
        setCategories(data.data?.categories ?? [])
      }
    } catch (err) {
      console.error('Failed to load categories:', err)
    }
  }, [])

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      if (selectedCategoryId) params.set('categoryId', selectedCategoryId)
      if (entryTypeFilter !== 'all') params.set('entryType', entryTypeFilter)
      if (searchQuery) params.set('q', searchQuery)
      params.set('offset', String(page * pageSize))
      params.set('limit', String(pageSize))

      const res = await fetch(
        `/api/admin/component-catalog?${params.toString()}`,
      )
      if (res.ok) {
        const data = await res.json()
        setEntries(data.data?.entries ?? [])
        setTotalEntries(data.data?.total ?? 0)
      }
    } catch (err) {
      console.error('Failed to load entries:', err)
    } finally {
      setLoading(false)
    }
  }, [selectedCategoryId, entryTypeFilter, searchQuery, page])

  useEffect(() => {
    loadCategories()
  }, [loadCategories])

  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  const handleDeleteEntry = async (id: string) => {
    if (!confirm('Delete this catalog entry?')) return
    try {
      await fetch(`/api/admin/component-catalog/${id}`, { method: 'DELETE' })
      loadEntries()
    } catch (err) {
      console.error('Failed to delete entry:', err)
    }
  }

  // Build category tree for sidebar
  const rootCategories = categories.filter((c) => !c.parentId)
  const childrenOf = (parentId: string) =>
    categories.filter((c) => c.parentId === parentId)

  return (
    <PageContainer
      title="Component Catalog"
      icon={<Database className="w-6 h-6" />}
      description="Manage the reference library of real, purchasable components and raw stock materials"
    >
      <div className="flex gap-6 h-[calc(100vh-12rem)]">
        {/* Category Sidebar */}
        <div className="w-64 flex-shrink-0 overflow-y-auto border-r border-slate-200 dark:border-slate-700 pr-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider">
              Categories
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowCategoryDialog(true)}
            >
              <Plus className="w-3 h-3" />
            </Button>
          </div>

          <button
            className={`w-full text-left px-2 py-1.5 rounded text-sm ${
              !selectedCategoryId
                ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
                : 'hover:bg-slate-50 dark:hover:bg-slate-800'
            }`}
            onClick={() => {
              setSelectedCategoryId(null)
              setPage(0)
            }}
          >
            All Categories
          </button>

          {rootCategories.map((cat) => (
            <CategoryTreeItem
              key={cat.id}
              category={cat}
              children={childrenOf}
              selectedId={selectedCategoryId}
              onSelect={(id) => {
                setSelectedCategoryId(id)
                setPage(0)
              }}
            />
          ))}
        </div>

        {/* Main Content */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Toolbar */}
          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <Input
                placeholder="Search components..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value)
                  setPage(0)
                }}
                className="pl-10"
              />
            </div>

            <select
              value={entryTypeFilter}
              onChange={(e) => {
                setEntryTypeFilter(e.target.value)
                setPage(0)
              }}
              className="h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm"
            >
              <option value="all">All Types</option>
              <option value="component">Components</option>
              <option value="raw_stock">Raw Stock</option>
            </select>

            <Button
              onClick={() => {
                setEditingEntry(null)
                setShowEntryDialog(true)
              }}
            >
              <Plus className="w-4 h-4 mr-1" />
              Add Entry
            </Button>

            <Button variant="outline" onClick={() => setShowImportDialog(true)}>
              <Upload className="w-4 h-4 mr-1" />
              Import
            </Button>
          </div>

          {/* Entries Table */}
          <div className="flex-1 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
              </div>
            ) : entries.length === 0 ? (
              <div className="text-center py-12 text-slate-500">
                No entries found.{' '}
                {searchQuery && 'Try a different search query.'}
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700">
                  <tr>
                    <th className="text-left py-2 px-3 font-medium text-slate-600 dark:text-slate-400">
                      Name
                    </th>
                    <th className="text-left py-2 px-3 font-medium text-slate-600 dark:text-slate-400">
                      Type
                    </th>
                    <th className="text-left py-2 px-3 font-medium text-slate-600 dark:text-slate-400">
                      Category
                    </th>
                    <th className="text-left py-2 px-3 font-medium text-slate-600 dark:text-slate-400">
                      Suppliers
                    </th>
                    <th className="text-left py-2 px-3 font-medium text-slate-600 dark:text-slate-400">
                      Verified
                    </th>
                    <th className="text-right py-2 px-3 font-medium text-slate-600 dark:text-slate-400">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={entry.id}
                      className="border-b border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/50 cursor-pointer"
                      onClick={() => {
                        setEditingEntry(entry)
                        setShowEntryDialog(true)
                      }}
                    >
                      <td className="py-2 px-3">
                        <div className="font-medium">{entry.name}</div>
                        {entry.description && (
                          <div className="text-xs text-slate-500 truncate max-w-md">
                            {entry.description}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        <Badge
                          variant={
                            entry.entryType === 'raw_stock'
                              ? 'secondary'
                              : 'default'
                          }
                        >
                          {entry.entryType === 'raw_stock'
                            ? 'Raw Stock'
                            : 'Component'}
                        </Badge>
                      </td>
                      <td className="py-2 px-3 text-slate-600 dark:text-slate-400">
                        {entry.category.name}
                      </td>
                      <td className="py-2 px-3">
                        {entry.suppliers.length > 0 ? (
                          <span className="text-slate-600 dark:text-slate-400">
                            {entry.suppliers[0].name}
                            {entry.suppliers[0].approximatePrice != null &&
                              ` ~$${entry.suppliers[0].approximatePrice}`}
                            {entry.suppliers.length > 1 &&
                              ` +${entry.suppliers.length - 1}`}
                          </span>
                        ) : (
                          <span className="text-slate-400">-</span>
                        )}
                      </td>
                      <td className="py-2 px-3">
                        {entry.verified ? (
                          <Badge variant="default">Verified</Badge>
                        ) : (
                          <Badge variant="secondary">Unverified</Badge>
                        )}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleDeleteEntry(entry.id)
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5 text-red-500" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination */}
          {totalEntries > pageSize && (
            <div className="flex items-center justify-between pt-3 border-t border-slate-200 dark:border-slate-700">
              <span className="text-sm text-slate-500">
                Showing {page * pageSize + 1}-
                {Math.min((page + 1) * pageSize, totalEntries)} of{' '}
                {totalEntries}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={(page + 1) * pageSize >= totalEntries}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Entry Create/Edit Dialog */}
      {showEntryDialog && (
        <EntryDialog
          entry={editingEntry}
          categories={categories}
          onClose={() => {
            setShowEntryDialog(false)
            setEditingEntry(null)
          }}
          onSaved={() => {
            setShowEntryDialog(false)
            setEditingEntry(null)
            loadEntries()
          }}
        />
      )}

      {/* Import Dialog */}
      {showImportDialog && (
        <ImportDialog
          onClose={() => setShowImportDialog(false)}
          onImported={() => {
            setShowImportDialog(false)
            loadEntries()
            loadCategories()
          }}
        />
      )}

      {/* Category Dialog */}
      {showCategoryDialog && (
        <CategoryDialog
          categories={categories}
          onClose={() => setShowCategoryDialog(false)}
          onSaved={() => {
            setShowCategoryDialog(false)
            loadCategories()
          }}
        />
      )}
    </PageContainer>
  )
}

// ============================================================================
// Category Tree Item
// ============================================================================

function CategoryTreeItem({
  category,
  children,
  selectedId,
  onSelect,
  depth = 0,
}: {
  category: Category
  children: (parentId: string) => Array<Category>
  selectedId: string | null
  onSelect: (id: string) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(true)
  const kids = children(category.id)

  return (
    <div>
      <button
        className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-1 ${
          selectedId === category.id
            ? 'bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300'
            : 'hover:bg-slate-50 dark:hover:bg-slate-800'
        }`}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={() => onSelect(category.id)}
      >
        {kids.length > 0 && (
          <ChevronRight
            className={`w-3 h-3 transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              setExpanded(!expanded)
            }}
          />
        )}
        <span className="truncate">{category.name}</span>
      </button>
      {expanded &&
        kids.map((child) => (
          <CategoryTreeItem
            key={child.id}
            category={child}
            children={children}
            selectedId={selectedId}
            onSelect={onSelect}
            depth={depth + 1}
          />
        ))}
    </div>
  )
}

// ============================================================================
// Entry Create/Edit Dialog
// ============================================================================

function EntryDialog({
  entry,
  categories,
  onClose,
  onSaved,
}: {
  entry: CatalogEntryWithCategory | null
  categories: Array<Category>
  onClose: () => void
  onSaved: () => void
}) {
  const isEditing = !!entry
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [name, setName] = useState(entry?.name ?? '')
  const [description, setDescription] = useState(entry?.description ?? '')
  const [categoryId, setCategoryId] = useState(entry?.category.id ?? '')
  const [entryType, setEntryType] = useState<'component' | 'raw_stock'>(
    entry?.entryType ?? 'component',
  )
  const [designNotes, setDesignNotes] = useState(entry?.designNotes ?? '')
  const [tags, setTags] = useState(entry?.tags.join(', ') ?? '')
  const [verified, setVerified] = useState(entry?.verified ?? false)
  const [specsJson, setSpecsJson] = useState(
    JSON.stringify(entry?.specs ?? {}, null, 2),
  )
  const [suppliersJson, setSuppliersJson] = useState(
    JSON.stringify(entry?.suppliers ?? [], null, 2),
  )
  const [dimensionsJson, setDimensionsJson] = useState(
    JSON.stringify(entry?.dimensions ?? null, null, 2),
  )
  const [mountingFeaturesJson, setMountingFeaturesJson] = useState(
    JSON.stringify(entry?.mountingFeatures ?? [], null, 2),
  )
  const [electricalJson, setElectricalJson] = useState(
    JSON.stringify(entry?.electrical ?? null, null, 2),
  )
  const [stockSizesJson, setStockSizesJson] = useState(
    JSON.stringify(entry?.stockSizes ?? null, null, 2),
  )

  const handleSubmit = async () => {
    setSaving(true)
    setError('')

    try {
      const parsedTags = tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)

      const body = {
        name,
        description: description || null,
        categoryId,
        entryType,
        designNotes: designNotes || null,
        tags: parsedTags,
        verified,
        specs: JSON.parse(specsJson),
        suppliers: JSON.parse(suppliersJson),
        dimensions: JSON.parse(dimensionsJson),
        mountingFeatures: JSON.parse(mountingFeaturesJson),
        electrical: JSON.parse(electricalJson),
        stockSizes: JSON.parse(stockSizesJson),
      }

      const url = isEditing
        ? `/api/admin/component-catalog/${entry.id}`
        : '/api/admin/component-catalog'
      const method = isEditing ? 'PUT' : 'POST'

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error?.message ?? 'Failed to save')
      }

      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">
            {isEditing ? 'Edit Entry' : 'New Catalog Entry'}
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Name *</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="NEMA 17 Stepper Motor (17HS4401)"
              />
            </div>
            <div>
              <Label>Category *</Label>
              <select
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className="w-full h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm"
              >
                <option value="">Select category...</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Dense, keyword-rich description for search..."
              rows={3}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>Entry Type</Label>
              <select
                value={entryType}
                onChange={(e) =>
                  setEntryType(e.target.value as 'component' | 'raw_stock')
                }
                className="w-full h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm"
              >
                <option value="component">Component</option>
                <option value="raw_stock">Raw Stock</option>
              </select>
            </div>
            <div className="flex items-end gap-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={verified}
                  onChange={(e) => setVerified(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-sm">Verified</span>
              </label>
            </div>
          </div>

          <div>
            <Label>Tags (comma-separated)</Label>
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="metric, stainless, M3, fastener"
            />
          </div>

          <div>
            <Label>Design Notes (LLM guidance)</Label>
            <Textarea
              value={designNotes}
              onChange={(e) => setDesignNotes(e.target.value)}
              placeholder="Pair with A4988 driver. Mount with M3x8 screws on 31mm bolt circle."
              rows={2}
            />
          </div>

          <div>
            <Label>Suppliers (JSON)</Label>
            <Textarea
              value={suppliersJson}
              onChange={(e) => setSuppliersJson(e.target.value)}
              rows={4}
              className="font-mono text-xs"
            />
          </div>

          <div>
            <Label>Dimensions (JSON)</Label>
            <Textarea
              value={dimensionsJson}
              onChange={(e) => setDimensionsJson(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </div>

          <div>
            <Label>Mounting Features (JSON)</Label>
            <Textarea
              value={mountingFeaturesJson}
              onChange={(e) => setMountingFeaturesJson(e.target.value)}
              rows={4}
              className="font-mono text-xs"
            />
          </div>

          <div>
            <Label>Electrical (JSON)</Label>
            <Textarea
              value={electricalJson}
              onChange={(e) => setElectricalJson(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </div>

          <div>
            <Label>Specs (JSON key-value)</Label>
            <Textarea
              value={specsJson}
              onChange={(e) => setSpecsJson(e.target.value)}
              rows={3}
              className="font-mono text-xs"
            />
          </div>

          {entryType === 'raw_stock' && (
            <div>
              <Label>Stock Sizes (JSON)</Label>
              <Textarea
                value={stockSizesJson}
                onChange={(e) => setStockSizesJson(e.target.value)}
                rows={5}
                className="font-mono text-xs"
              />
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-slate-200 dark:border-slate-700">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={saving || !name || !categoryId}
          >
            {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            {isEditing ? 'Save Changes' : 'Create Entry'}
          </Button>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Import Dialog
// ============================================================================

type FileRowStatus =
  | { state: 'pending' }
  | { state: 'uploading' }
  | {
      state: 'success'
      successCount: number
      errorCount: number
      errors: Array<{ row: number; message: string }>
    }
  | { state: 'failed'; message: string }

interface FileRow {
  id: string
  file: File
  status: FileRowStatus
}

function ImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => void
}) {
  const [files, setFiles] = useState<Array<FileRow>>([])
  const [isDragging, setIsDragging] = useState(false)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback((incoming: Array<File>) => {
    if (incoming.length === 0) return
    setFiles((prev) => [
      ...prev,
      ...incoming.map((file) => ({
        id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
        file,
        status: { state: 'pending' as const },
      })),
    ])
  }, [])

  const handleDragEnter = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(true)
  }
  const handleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }
  const handleDragOver = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }
  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
    addFiles(Array.from(e.dataTransfer.files))
  }
  const handleFileInput = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) addFiles(Array.from(e.target.files))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id))
  }

  const updateStatus = (id: string, status: FileRowStatus) => {
    setFiles((prev) => prev.map((f) => (f.id === id ? { ...f, status } : f)))
  }

  const handleImport = async () => {
    setImporting(true)
    const pending = files.filter((f) => f.status.state !== 'success')
    for (const row of pending) {
      updateStatus(row.id, { state: 'uploading' })
      try {
        const text = await row.file.text()
        const parsed = JSON.parse(text)
        if (!Array.isArray(parsed)) {
          throw new Error('JSON must be an array of entries')
        }
        const res = await fetch('/api/admin/component-catalog/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ rows: parsed }),
        })
        const data = await res.json()
        if (!res.ok && res.status !== 207) {
          const message =
            data?.error?.message ||
            data?.message ||
            `Server returned ${res.status}`
          updateStatus(row.id, { state: 'failed', message })
          continue
        }
        const result = data.data ?? {
          successCount: 0,
          errorCount: 0,
          errors: [],
        }
        updateStatus(row.id, {
          state: 'success',
          successCount: result.successCount ?? 0,
          errorCount: result.errorCount ?? 0,
          errors: result.errors ?? [],
        })
      } catch (err) {
        updateStatus(row.id, {
          state: 'failed',
          message: err instanceof Error ? err.message : 'Import failed',
        })
      }
    }
    setImporting(false)
  }

  const totals = files.reduce(
    (acc, f) => {
      if (f.status.state === 'success') {
        acc.successFiles += 1
        acc.successRows += f.status.successCount
        acc.errorRows += f.status.errorCount
      } else if (f.status.state === 'failed') {
        acc.failedFiles += 1
      }
      return acc
    },
    { successFiles: 0, failedFiles: 0, successRows: 0, errorRows: 0 },
  )

  const anyDone = totals.successFiles > 0 || totals.failedFiles > 0
  const allProcessed =
    files.length > 0 &&
    files.every(
      (f) => f.status.state === 'success' || f.status.state === 'failed',
    )

  const handleClose = () => {
    if (totals.successRows > 0) onImported()
    else onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-2xl max-h-[85vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Bulk Import</h2>
          <Button variant="ghost" size="sm" onClick={handleClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <p className="text-sm text-slate-600 dark:text-slate-400 mb-3">
          Drop one or more <code>.json</code> files. Each file should contain an
          array of catalog entries (e.g. the files in <code>test-data/</code>).
          Each entry needs at minimum <code>name</code>, <code>entryType</code>,
          and <code>categorySlug</code> or <code>categoryId</code>.
        </p>

        <div
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`mb-4 border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
            isDragging
              ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
              : 'border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600'
          }`}
        >
          <Upload className="w-8 h-8 mx-auto mb-2 text-slate-400" />
          <div className="text-sm text-slate-600 dark:text-slate-400">
            Drop <code>.json</code> files here, or click to browse
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            multiple
            className="hidden"
            onChange={handleFileInput}
          />
        </div>

        {files.length > 0 && (
          <div className="mb-4 space-y-2">
            {files.map((row) => (
              <div
                key={row.id}
                className="border rounded p-2 bg-slate-50 dark:bg-slate-800 text-sm"
              >
                <div className="flex items-center gap-2">
                  <FileJson className="w-4 h-4 text-slate-500 shrink-0" />
                  <span className="font-mono text-xs truncate flex-1">
                    {row.file.name}
                  </span>
                  <StatusBadge status={row.status} />
                  {!importing && row.status.state !== 'uploading' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeFile(row.id)}
                      className="h-6 w-6 p-0"
                    >
                      <X className="w-3 h-3" />
                    </Button>
                  )}
                </div>
                {row.status.state === 'success' &&
                  row.status.errors.length > 0 && (
                    <div className="mt-2 pl-6 space-y-0.5 text-xs">
                      {row.status.errors.slice(0, 5).map((e, i) => (
                        <div key={i} className="text-red-600 dark:text-red-400">
                          Row {e.row}: {e.message}
                        </div>
                      ))}
                      {row.status.errors.length > 5 && (
                        <div className="text-slate-500">
                          …and {row.status.errors.length - 5} more
                        </div>
                      )}
                    </div>
                  )}
                {row.status.state === 'failed' && (
                  <div className="mt-1 pl-6 text-xs text-red-600 dark:text-red-400">
                    {row.status.message}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {anyDone && (
          <div className="mb-4 p-3 bg-slate-50 dark:bg-slate-800 rounded text-sm">
            Imported {totals.successRows} entries across {totals.successFiles}{' '}
            {totals.successFiles === 1 ? 'file' : 'files'}.
            {totals.errorRows > 0 && ` ${totals.errorRows} rows failed.`}
            {totals.failedFiles > 0 &&
              ` ${totals.failedFiles} ${totals.failedFiles === 1 ? 'file' : 'files'} failed to process.`}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={handleClose}>
            Close
          </Button>
          <Button
            onClick={handleImport}
            disabled={
              importing ||
              files.length === 0 ||
              files.every((f) => f.status.state === 'success')
            }
          >
            {importing && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            {allProcessed && !importing ? 'Re-run failed' : 'Import'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: FileRowStatus }) {
  switch (status.state) {
    case 'pending':
      return (
        <span className="text-xs text-slate-500 px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700">
          Pending
        </span>
      )
    case 'uploading':
      return (
        <span className="text-xs text-blue-600 dark:text-blue-400 flex items-center gap-1">
          <Loader2 className="w-3 h-3 animate-spin" />
          Uploading
        </span>
      )
    case 'success':
      return (
        <span
          className={`text-xs flex items-center gap-1 ${
            status.errorCount > 0
              ? 'text-amber-600 dark:text-amber-400'
              : 'text-green-600 dark:text-green-400'
          }`}
        >
          <CheckCircle2 className="w-3 h-3" />
          {status.successCount} imported
          {status.errorCount > 0 && `, ${status.errorCount} failed`}
        </span>
      )
    case 'failed':
      return (
        <span className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" />
          Failed
        </span>
      )
  }
}

// ============================================================================
// Category Create Dialog
// ============================================================================

function CategoryDialog({
  categories,
  onClose,
  onSaved,
}: {
  categories: Array<Category>
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [parentId, setParentId] = useState<string>('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async () => {
    setSaving(true)
    setError('')

    try {
      const res = await fetch('/api/admin/component-catalog/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          slug,
          parentId: parentId || null,
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error?.message ?? 'Failed to create category')
      }

      onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/50">
      <div className="bg-white dark:bg-slate-900 rounded-lg shadow-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">New Category</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 rounded text-sm">
            {error}
          </div>
        )}

        <div className="space-y-4">
          <div>
            <Label>Name *</Label>
            <Input
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                if (!slug) {
                  setSlug(
                    e.target.value
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, '-')
                      .replace(/^-|-$/g, ''),
                  )
                }
              }}
              placeholder="Linear Motion"
            />
          </div>
          <div>
            <Label>Slug *</Label>
            <Input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="linear-motion"
            />
          </div>
          <div>
            <Label>Parent Category</Label>
            <select
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              className="w-full h-9 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 text-sm"
            >
              <option value="">None (top-level)</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6 pt-4 border-t border-slate-200 dark:border-slate-700">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={saving || !name || !slug}>
            {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Create Category
          </Button>
        </div>
      </div>
    </div>
  )
}
