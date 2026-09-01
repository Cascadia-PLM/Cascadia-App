// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { CheckCircle2, Factory, Loader2, XCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { Checkbox } from '@/components/ui/Checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { apiFetch } from '@/lib/api/client'
import { designTagsQuery, useResourceMutation } from '@/lib/query'

interface Tag {
  id: string
  name: string
  tagType: string
  createdAt: string
}

interface CreateMbomDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceDesignId: string
  sourceDesignCode: string
  sourceDesignName: string
}

interface MbomResult {
  design: {
    id: string
    code: string
    name: string
  }
  itemsCopied: number
  relationshipsCopied: number
  sourceLinks: number
}

export function CreateMbomDialog({
  open,
  onOpenChange,
  sourceDesignId,
  sourceDesignCode,
  sourceDesignName,
}: CreateMbomDialogProps) {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sourceTagId, setSourceTagId] = useState<string>('__current__')
  const [copyBomStructure, setCopyBomStructure] = useState(true)
  const [linkToSource, setLinkToSource] = useState(true)
  const [renumberItems, setRenumberItems] = useState(true)

  // The baseline tags are only worth asking for while the dialog is on
  // screen, but the answer is the one every other reader of this design's
  // tags already holds — so it comes from the shared cache rather than from
  // a fetch this component owns.
  const { data: tags = [], isFetching: isLoadingTags } = useQuery({
    ...designTagsQuery<Tag>(sourceDesignId),
    enabled: open,
  })

  /**
   * Creating an MBOM mints a whole Manufacturing design carrying copies of
   * the source items, so `designs` goes stale alongside `mbom` — without it
   * the designs list keeps its pre-creation rows until something else happens
   * to refetch them.
   */
  const createMbom = useResourceMutation<MbomResult, Error, void>({
    mutationFn: async () => {
      const response = await apiFetch<{ data: MbomResult }>('/api/v1/mbom', {
        method: 'POST',
        body: JSON.stringify({
          sourceDesignId,
          code: code.toUpperCase(),
          name,
          description: description || undefined,
          sourceTagId: sourceTagId === '__current__' ? undefined : sourceTagId,
          copyBomStructure,
          linkToSource,
          renumberItems,
        }),
      })
      return response.data
    },
    invalidates: ['mbom', 'designs'],
  })

  const result = createMbom.data ?? null
  const error = createMbom.error
    ? createMbom.error.message || 'Failed to create MBOM'
    : null
  const isFormDisabled = createMbom.isPending

  // Reset the form each time the dialog opens. State only — the tags come
  // from the query above, which needs no prompting.
  useEffect(() => {
    if (open) {
      setCode(`M-${sourceDesignCode}`)
      setName(`${sourceDesignName} (MBOM)`)
      setDescription('')
      setSourceTagId('__current__')
      setCopyBomStructure(true)
      setLinkToSource(true)
      setRenumberItems(true)
      createMbom.reset()
    }
  }, [open, sourceDesignCode, sourceDesignName])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    createMbom.mutate()
  }

  const handleNavigateToNewDesign = () => {
    if (result) {
      onOpenChange(false)
      navigate({ to: '/designs/$id', params: { id: result.design.id } })
    }
  }

  const handleClose = () => {
    if (createMbom.isPending) {
      return
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Factory className="h-5 w-5" />
            Release to Manufacturing
          </DialogTitle>
          <DialogDescription>
            Create a Manufacturing BOM from{' '}
            <span className="font-medium">{sourceDesignCode}</span>. The MBOM
            will be linked to the source EBOM for traceability.
          </DialogDescription>
        </DialogHeader>

        {!result && !createMbom.isError ? (
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              {/* Source Design Info */}
              <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-3 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500 dark:text-slate-400">
                    Source Design:
                  </span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    {sourceDesignCode}
                  </span>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-slate-500 dark:text-slate-400">
                    Type:
                  </span>
                  <span className="font-medium text-slate-900 dark:text-slate-100">
                    Engineering (EBOM)
                  </span>
                </div>
              </div>

              {/* Baseline Tag Selector */}
              <div className="space-y-2">
                <Label htmlFor="sourceTag">Baseline Tag (optional)</Label>
                <Select
                  value={sourceTagId}
                  onValueChange={setSourceTagId}
                  disabled={isFormDisabled || isLoadingTags}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Use current HEAD" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__current__">
                      Use current HEAD
                    </SelectItem>
                    {tags.map((tag) => (
                      <SelectItem key={tag.id} value={tag.id}>
                        {tag.name} ({tag.tagType})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Select a specific baseline tag, or use the current state.
                </p>
              </div>

              {/* MBOM Design Code */}
              <div className="space-y-2">
                <Label htmlFor="code">Manufacturing Design Code</Label>
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="e.g., M-HULL-1"
                  required
                  disabled={isFormDisabled}
                  pattern="[A-Z0-9\-]+"
                  title="Uppercase letters, numbers, and hyphens only"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Must be unique. Typically prefixed with M- for manufacturing.
                </p>
              </div>

              {/* MBOM Design Name */}
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Hull Assembly (MBOM)"
                  required
                  disabled={isFormDisabled}
                />
              </div>

              {/* Description */}
              <div className="space-y-2">
                <Label htmlFor="description">Description (optional)</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description of the manufacturing design..."
                  rows={2}
                  disabled={isFormDisabled}
                />
              </div>

              {/* Options */}
              <div className="space-y-3 pt-2">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="copyBom"
                    checked={copyBomStructure}
                    onCheckedChange={(checked) =>
                      setCopyBomStructure(checked as boolean)
                    }
                    disabled={isFormDisabled}
                  />
                  <Label htmlFor="copyBom" className="text-sm font-normal">
                    Copy BOM structure to MBOM
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="linkSource"
                    checked={linkToSource}
                    onCheckedChange={(checked) =>
                      setLinkToSource(checked as boolean)
                    }
                    disabled={isFormDisabled}
                  />
                  <Label htmlFor="linkSource" className="text-sm font-normal">
                    Create traceability links to source EBOM
                  </Label>
                </div>

                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="renumberItems"
                    checked={renumberItems}
                    onCheckedChange={(checked) =>
                      setRenumberItems(checked as boolean)
                    }
                    disabled={isFormDisabled || !copyBomStructure}
                  />
                  <Label
                    htmlFor="renumberItems"
                    className={`text-sm font-normal ${!copyBomStructure ? 'text-slate-400 dark:text-slate-600' : ''}`}
                  >
                    Renumber item suffixes ({sourceDesignCode} &rarr;{' '}
                    {code || `M-${sourceDesignCode}`})
                  </Label>
                </div>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={createMbom.isPending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isFormDisabled}>
                {createMbom.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  'Create MBOM'
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : result ? (
          <div className="py-8 space-y-4">
            <div className="flex items-center justify-center">
              <CheckCircle2 className="h-12 w-12 text-green-600 dark:text-green-400" />
            </div>
            <div className="text-center">
              <p className="font-medium text-lg text-slate-900 dark:text-slate-100">
                MBOM Created
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Created{' '}
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.design.code}
                </span>
              </p>
            </div>
            <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-4 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Items copied:
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.itemsCopied}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  BOM relationships:
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.relationshipsCopied}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Source links created:
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.sourceLinks}
                </span>
              </div>
            </div>
            <DialogFooter className="sm:justify-center">
              <Button onClick={handleNavigateToNewDesign}>
                Go to MBOM Design
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="py-8 space-y-4">
            <div className="flex items-center justify-center">
              <XCircle className="h-12 w-12 text-red-600 dark:text-red-400" />
            </div>
            <div className="text-center">
              <p className="font-medium text-lg text-slate-900 dark:text-slate-100">
                Creation Failed
              </p>
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                {error}
              </p>
            </div>
            <DialogFooter className="sm:justify-center">
              <Button variant="outline" onClick={() => createMbom.reset()}>
                Try Again
              </Button>
              <Button onClick={handleClose}>Close</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
