import { useEffect, useState } from 'react'
import { Link2, Loader2, Search, Trash2, Variable } from 'lucide-react'
import type { StepContentBlock } from '@/lib/items/types/work-instruction'
import { Button, Input } from '@/components/ui'

interface PartSearchResult {
  id: string
  itemNumber: string
  name?: string
  revision: string
}

interface ResolvableAttribute {
  path: string
  label: string
  value: string | null
}

interface ParametricBlockEditorProps {
  block: StepContentBlock
  workInstructionId: string
  onUpdate: (block: StepContentBlock) => void
  onDelete: () => void
  onError?: (error: Error) => void
}

export function ParametricBlockEditor({
  block,
  workInstructionId: _workInstructionId,
  onUpdate,
  onDelete,
  onError: _onError,
}: ParametricBlockEditorProps) {
  const [partSearch, setPartSearch] = useState('')
  const [searchResults, setSearchResults] = useState<Array<PartSearchResult>>(
    [],
  )
  const [searching, setSearching] = useState(false)
  const [selectedPart, setSelectedPart] = useState<PartSearchResult | null>(
    null,
  )
  const [attributes, setAttributes] = useState<Array<ResolvableAttribute>>([])
  const [loadingAttrs, setLoadingAttrs] = useState(false)
  const [resolvedPreview, setResolvedPreview] = useState<string | null>(null)

  // Load selected part info if block already has a partId
  useEffect(() => {
    if (block.partId && !selectedPart) {
      fetch(`/api/v1/parts/${block.partId}`)
        .then((r) => r.json())
        .then((data) => {
          const part = data.data?.part || data.data
          if (part) {
            setSelectedPart({
              id: part.id,
              itemNumber: part.itemNumber,
              name: part.name,
              revision: part.revision,
            })
          }
        })
        .catch(() => {})
    }
  }, [block.partId])

  // Load attributes when part is selected
  useEffect(() => {
    if (!block.partId) {
      setAttributes([])
      return
    }

    setLoadingAttrs(true)
    fetch(`/api/v1/parts/${block.partId}/resolvable-attributes`)
      .then((r) => r.json())
      .then((data) => {
        setAttributes(data.data?.attributes || [])
      })
      .catch(() => setAttributes([]))
      .finally(() => setLoadingAttrs(false))
  }, [block.partId])

  // Update preview when attribute changes
  useEffect(() => {
    if (block.partId && block.attributePath) {
      const attr = attributes.find((a) => a.path === block.attributePath)
      setResolvedPreview(attr?.value ?? null)
    } else {
      setResolvedPreview(null)
    }
  }, [block.attributePath, attributes])

  // Search for parts
  useEffect(() => {
    if (partSearch.length < 2) {
      setSearchResults([])
      return
    }

    const timeout = setTimeout(async () => {
      setSearching(true)
      try {
        const response = await fetch(
          `/api/v1/items/search?q=${encodeURIComponent(partSearch)}&type=Part&limit=10`,
        )
        const data = await response.json()
        setSearchResults(
          (data.data?.items || []).map((item: Record<string, unknown>) => ({
            id: item.id,
            itemNumber: item.itemNumber,
            name: item.name,
            revision: item.revision,
          })),
        )
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 300)

    return () => clearTimeout(timeout)
  }, [partSearch])

  const handleSelectPart = (part: PartSearchResult) => {
    setSelectedPart(part)
    setPartSearch('')
    setSearchResults([])
    onUpdate({
      ...block,
      partId: part.id,
      attributePath: undefined,
    })
  }

  const handleSelectAttribute = (path: string) => {
    onUpdate({ ...block, attributePath: path })
  }

  return (
    <div className="relative group border rounded-lg p-4 bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-700">
      <div className="flex items-center gap-2 mb-3">
        <Variable className="h-4 w-4 text-purple-600 dark:text-purple-400" />
        <span className="text-sm font-medium text-purple-700 dark:text-purple-300">
          Parametric Value
        </span>
      </div>

      {/* Part selection */}
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
            Part
          </label>
          {selectedPart ? (
            <div className="flex items-center gap-2 p-2 bg-white dark:bg-slate-800 rounded border">
              <Link2 className="h-4 w-4 text-purple-500" />
              <span className="font-medium text-sm">
                {selectedPart.itemNumber}
              </span>
              <span className="text-sm text-slate-500">
                {selectedPart.name}
              </span>
              <span className="text-xs text-slate-400">
                Rev {selectedPart.revision}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 ml-auto"
                onClick={() => {
                  setSelectedPart(null)
                  onUpdate({
                    ...block,
                    partId: undefined,
                    attributePath: undefined,
                  })
                }}
              >
                <Trash2 className="h-3 w-3 text-red-500" />
              </Button>
            </div>
          ) : (
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-4 w-4 text-slate-400" />
              <Input
                value={partSearch}
                onChange={(e) => setPartSearch(e.target.value)}
                placeholder="Search for a part..."
                className="pl-8"
              />
              {searching && (
                <Loader2 className="absolute right-2 top-2.5 h-4 w-4 animate-spin text-slate-400" />
              )}
              {searchResults.length > 0 && (
                <div className="absolute z-10 w-full mt-1 bg-white dark:bg-slate-800 border rounded-lg shadow-lg max-h-48 overflow-auto">
                  {searchResults.map((part) => (
                    <button
                      key={part.id}
                      className="w-full text-left px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700 text-sm"
                      onClick={() => handleSelectPart(part)}
                    >
                      <span className="font-medium">{part.itemNumber}</span>
                      {part.name && (
                        <span className="text-slate-500 ml-2">{part.name}</span>
                      )}
                      <span className="text-xs text-slate-400 ml-2">
                        Rev {part.revision}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Attribute selection */}
        {block.partId && (
          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
              Attribute
            </label>
            {loadingAttrs ? (
              <div className="flex items-center gap-2 text-sm text-slate-500">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading attributes...
              </div>
            ) : (
              <select
                className="w-full border rounded px-3 py-2 text-sm bg-white dark:bg-slate-800 dark:border-slate-600"
                value={block.attributePath || ''}
                onChange={(e) => handleSelectAttribute(e.target.value)}
              >
                <option value="">Select an attribute...</option>
                {attributes.map((attr) => (
                  <option key={attr.path} value={attr.path}>
                    {attr.label}
                    {attr.value != null ? ` (${attr.value})` : ''}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        {/* Label & Unit */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
              Label (optional)
            </label>
            <Input
              value={block.label || ''}
              onChange={(e) => onUpdate({ ...block, label: e.target.value })}
              placeholder="e.g., Weight"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
              Unit (optional)
            </label>
            <Input
              value={block.unit || ''}
              onChange={(e) => onUpdate({ ...block, unit: e.target.value })}
              placeholder="e.g., kg"
            />
          </div>
        </div>

        {/* Fallback */}
        <div>
          <label className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1 block">
            Fallback value (shown when part unavailable)
          </label>
          <Input
            value={block.fallbackValue || ''}
            onChange={(e) =>
              onUpdate({ ...block, fallbackValue: e.target.value })
            }
            placeholder="e.g., N/A"
          />
        </div>

        {/* Live preview */}
        {block.partId && block.attributePath && (
          <div className="mt-2 p-3 bg-white dark:bg-slate-800 rounded border">
            <span className="text-xs text-slate-500 block mb-1">Preview</span>
            <div className="flex items-center gap-2">
              {block.label && (
                <span className="text-sm font-medium text-purple-700 dark:text-purple-300">
                  {block.label}:
                </span>
              )}
              <span className="text-lg font-semibold text-purple-900 dark:text-purple-100">
                {resolvedPreview ?? block.fallbackValue ?? '—'}
              </span>
              {block.unit && (
                <span className="text-sm text-purple-600 dark:text-purple-400">
                  {block.unit}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity h-6 w-6"
        onClick={onDelete}
      >
        <Trash2 className="h-4 w-4 text-red-500" />
      </Button>
    </div>
  )
}
