// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  ArrowDownRight,
  Link2,
  Package,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from '@/components/ui'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api/client'
import {
  entitySubQuery,
  itemTextSearchQuery,
  useInvalidateResources,
} from '@/lib/query'
import { useDebouncedValue } from '@/lib/hooks/useDebouncedValue'

interface PartSearchResult {
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  designCode?: string
  designName?: string
}

interface PartAttachment {
  id: string
  partId: string
  isOutput: boolean
  inheritToMBOM: boolean
  inheritedFromId?: string | null
  createdAt: string
  part: {
    id: string
    itemNumber: string
    name: string
    revision: string
  }
}

interface PartAttachmentPanelProps {
  workInstructionId: string
  /**
   * Hide attach/detach/toggle affordances. Attachments are content edits of
   * the work instruction, so they follow the click-Edit (checkout) policy —
   * the parent passes readOnly until the user holds the edit lock. The
   * server enforces the same rule regardless.
   */
  readOnly?: boolean
  onError?: (error: Error) => void
  onSuccess?: (message: string) => void
}

export function PartAttachmentPanel({
  workInstructionId,
  readOnly = false,
  onError,
  onSuccess,
}: PartAttachmentPanelProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [showSearch, setShowSearch] = useState(false)
  const [attaching, setAttaching] = useState<string | null>(null)
  const invalidate = useInvalidateResources()

  const { data: attachmentRows = [], isPending: loading } = useQuery(
    entitySubQuery<PartAttachment>(
      'work-instructions',
      workInstructionId,
      'parts',
      'attachments',
    ),
  )
  // Output part first — it is the one that decides the WI's design, so it
  // should not be somewhere in the middle of a long attachment list.
  const attachments = [...attachmentRows].sort(
    (a, b) => Number(b.isOutput) - Number(a.isOutput),
  )

  const debouncedSearch = useDebouncedValue(searchQuery)
  const { data: searchHits = [], isFetching: searching } = useQuery(
    itemTextSearchQuery<PartSearchResult>(
      { q: debouncedSearch, types: ['Part'], limit: 10 },
      debouncedSearch.length >= 2,
    ),
  )
  const attachedIds = new Set(attachments.map((a) => a.partId))
  const searchResults = searchHits.filter((hit) => !attachedIds.has(hit.id))

  const handleAttach = async (part: PartSearchResult) => {
    setAttaching(part.id)
    try {
      await apiFetch(`/api/v1/work-instructions/${workInstructionId}/parts`, {
        method: 'POST',
        body: JSON.stringify({ partId: part.id }),
      })
      await invalidate('work-instructions')

      setSearchQuery('')
      setShowSearch(false)

      onSuccess?.(`Attached ${part.itemNumber}`)
    } catch (error) {
      onError?.(error as Error)
    } finally {
      setAttaching(null)
    }
  }

  const handleToggleInherit = async (attachment: PartAttachment) => {
    try {
      await apiFetch(`/api/v1/work-instructions/${workInstructionId}/parts`, {
        method: 'PATCH',
        body: JSON.stringify({
          partId: attachment.partId,
          inheritToMBOM: !attachment.inheritToMBOM,
        }),
      })
      await invalidate('work-instructions')
      onSuccess?.(
        `${attachment.inheritToMBOM ? 'Disabled' : 'Enabled'} MBOM inheritance for ${attachment.part.itemNumber}`,
      )
    } catch (error) {
      onError?.(error as Error)
    }
  }

  /**
   * Re-point the output part. This moves the work instruction into the new
   * part's design server-side, so the whole list is reloaded rather than
   * patched locally — the old output attachment also changed.
   */
  const handleSetOutput = async (attachment: PartAttachment) => {
    try {
      await apiFetch(`/api/v1/work-instructions/${workInstructionId}/parts`, {
        method: 'PATCH',
        body: JSON.stringify({ partId: attachment.partId, isOutput: true }),
      })
      await invalidate('work-instructions')
      onSuccess?.(`${attachment.part.itemNumber} is now the output part`)
    } catch (error) {
      onError?.(error as Error)
    }
  }

  const handleDetach = async (attachment: PartAttachment) => {
    try {
      await apiFetch(
        `/api/v1/work-instructions/${workInstructionId}/parts?partId=${attachment.partId}`,
        { method: 'DELETE' },
      )
      await invalidate('work-instructions')
      onSuccess?.(`Detached ${attachment.part.itemNumber}`)
    } catch (error) {
      onError?.(error as Error)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Link2 className="h-5 w-5" />
              Attached Parts
            </CardTitle>
            <CardDescription>
              The output part is what this procedure builds and sets the work
              instruction's design; the rest are parts it also applies to.
            </CardDescription>
          </div>
          {!showSearch && !readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSearch(true)}
            >
              <Plus className="h-4 w-4 mr-2" />
              Attach Part
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Search Section */}
        {showSearch && (
          <div className="space-y-3 p-4 bg-slate-50 dark:bg-slate-800/50 rounded-lg">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-slate-700 dark:text-slate-300">
                Search for a part to attach
              </label>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => {
                  setShowSearch(false)
                  setSearchQuery('')
                }}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <Input
                placeholder="Search by part number or name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9"
                autoFocus
              />
            </div>

            {/* Search Results */}
            {searching && (
              <p className="text-sm text-slate-500 py-2">Searching...</p>
            )}
            {!searching &&
              searchQuery.length >= 2 &&
              searchResults.length === 0 && (
                <p className="text-sm text-slate-500 py-2">
                  No parts found matching "{searchQuery}"
                </p>
              )}
            {searchResults.length > 0 && (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {searchResults.map((part) => (
                  <div
                    key={part.id}
                    className={cn(
                      'flex items-center justify-between p-2 rounded-md',
                      'hover:bg-slate-100 dark:hover:bg-slate-700',
                      'transition-colors cursor-pointer',
                    )}
                    onClick={() => handleAttach(part)}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sky-600 dark:text-sky-400">
                          {part.itemNumber}
                        </span>
                        <Badge variant="secondary" className="text-xs">
                          Rev {part.revision}
                        </Badge>
                      </div>
                      <p className="text-sm text-slate-600 dark:text-slate-400 truncate">
                        {part.name || 'Unnamed part'}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={attaching === part.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleAttach(part)
                      }}
                    >
                      {attaching === part.id ? (
                        'Adding...'
                      ) : (
                        <>
                          <Plus className="h-4 w-4 mr-1" />
                          Add
                        </>
                      )}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Attachments List */}
        {loading ? (
          <p className="text-slate-500 text-center py-4">
            Loading attachments...
          </p>
        ) : attachments.length === 0 ? (
          <p className="text-slate-500 text-center py-8">
            No parts attached yet.
            {!showSearch && !readOnly && (
              <> Click "Attach Part" to link parts to this work instruction.</>
            )}
          </p>
        ) : (
          <div className="space-y-2">
            {attachments.map((attachment) => (
              <div
                key={attachment.id}
                className="flex items-center justify-between p-3 bg-white dark:bg-slate-800 border dark:border-slate-700 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      to="/parts/$id"
                      params={{ id: attachment.part.id }}
                      className="font-medium text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
                    >
                      {attachment.part.itemNumber}
                    </Link>
                    <Badge variant="secondary" className="text-xs">
                      Rev {attachment.part.revision}
                    </Badge>
                    {attachment.isOutput && (
                      <Badge variant="default" className="text-xs gap-1">
                        <Package className="h-3 w-3" />
                        Output Part
                      </Badge>
                    )}
                    {attachment.inheritedFromId && (
                      <Badge variant="outline" className="text-xs gap-1">
                        <ArrowDownRight className="h-3 w-3" />
                        Inherited
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-600 dark:text-slate-400 truncate">
                    {attachment.part.name || 'Unnamed part'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {/* Inherit to MBOM toggle */}
                  {!attachment.inheritedFromId &&
                    (readOnly ? (
                      attachment.inheritToMBOM && (
                        <span className="flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
                          <ArrowDownRight className="h-3 w-3" />
                          Inherits to MBOM
                        </span>
                      )
                    ) : (
                      <button
                        className={cn(
                          'flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors',
                          attachment.inheritToMBOM
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                            : 'bg-slate-100 text-slate-500 dark:bg-slate-700 dark:text-slate-400',
                        )}
                        onClick={() => handleToggleInherit(attachment)}
                        title={
                          attachment.inheritToMBOM
                            ? 'Click to disable MBOM inheritance'
                            : 'Click to enable MBOM inheritance'
                        }
                      >
                        <ArrowDownRight className="h-3 w-3" />
                        {attachment.inheritToMBOM
                          ? 'Inherits to MBOM'
                          : 'No MBOM inherit'}
                      </button>
                    ))}
                  {!readOnly && !attachment.isOutput && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSetOutput(attachment)}
                        title="Make this the part the procedure builds. Moves the work instruction into this part's design."
                      >
                        Set as output
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="text-slate-400 hover:text-red-600 dark:hover:text-red-400"
                        onClick={() => handleDetach(attachment)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
