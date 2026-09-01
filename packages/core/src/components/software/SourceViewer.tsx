// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileArchive,
  FileDiff,
  FilePlus,
  Folder,
  FolderOpen,
  GitCommitHorizontal,
  Pencil,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { oneDark } from '@codemirror/theme-one-dark'
import { languageFor } from './language'
import { SourceDiffDialog } from './SourceDiffDialog'
import type { Extension } from '@codemirror/state'
import type { SourceDiffTarget } from './SourceDiffDialog'
import type { SoftwareManifestEntry, SoftwareVersion } from '@/lib/query'
import {
  Badge,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Textarea,
} from '@/components/ui'
import { useAlertDialog } from '@/lib/hooks/useAlertDialog'
import { useErrorHandler } from '@/lib/hooks/useErrorHandler'
import { apiFetch } from '@/lib/api/client'
import {
  softwareDiffQuery,
  softwareFileQuery,
  softwareTreeQuery,
  softwareVersionsQuery,
  useInvalidateResources,
  useResourceMutation,
} from '@/lib/query'
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

interface SourceViewerProps {
  itemId: string
  /** Show the import affordance (server still enforces branch protection) */
  canImport?: boolean
  /** Enable in-app editing (server still enforces checkout/lock rules) */
  canEdit?: boolean
  /** Called after a successful import/commit so the parent can refresh */
  onImported?: () => void
}

// ============================================================================
// File-tree building (flat manifest paths -> nested folders)
// ============================================================================

interface TreeNode {
  name: string
  path: string
  children: Map<string, TreeNode>
  entry?: SoftwareManifestEntry
}

function buildTree(entries: Array<SoftwareManifestEntry>): TreeNode {
  const root: TreeNode = { name: '', path: '', children: new Map() }
  for (const entry of entries) {
    const segments = entry.path.split('/')
    let node = root
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i]!
      const path = segments.slice(0, i + 1).join('/')
      let child = node.children.get(name)
      if (!child) {
        child = { name, path, children: new Map() }
        node.children.set(name, child)
      }
      node = child
    }
    node.entry = entry
  }
  return root
}

/** Folders first, then files, each alphabetically. */
function sortedChildren(node: TreeNode): Array<TreeNode> {
  return Array.from(node.children.values()).sort((a, b) => {
    const aIsDir = a.children.size > 0
    const bIsDir = b.children.size > 0
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ============================================================================
// CodeMirror editor (read-only or editable)
// ============================================================================

function CodeEditor({
  content,
  path,
  readOnly,
  onChange,
}: {
  content: string
  path: string
  readOnly: boolean
  onChange?: (doc: string) => void
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!containerRef.current) return

    const isDark = document.documentElement.classList.contains('dark')
    const extensions: Array<Extension> = [
      basicSetup,
      EditorView.theme({
        '&': { fontSize: '13px' },
        '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
      }),
    ]
    if (readOnly) {
      extensions.push(
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      )
    } else {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString())
          }
        }),
      )
    }
    const lang = languageFor(path)
    if (lang) extensions.push(lang)
    if (isDark) extensions.push(oneDark)

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: containerRef.current,
    })

    return () => view.destroy()
    // Recreate only when switching files or toggling edit mode - `content`
    // is the initial doc, not a controlled value. A background refetch of
    // the same file therefore leaves the user's in-progress edits alone.
  }, [path, readOnly])

  return <div ref={containerRef} className="max-h-[65vh] overflow-auto" />
}

// ============================================================================
// Tree rendering
// ============================================================================

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  dirtyPaths,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
  dirtyPaths: Set<string>
  onSelect: (path: string) => void
}) {
  const isDir = node.children.size > 0
  const [open, setOpen] = useState(depth < 2)

  if (isDir) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          style={{ paddingLeft: `${depth * 14 + 8}px` }}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          {open ? (
            <FolderOpen className="h-4 w-4 shrink-0 text-amber-500" />
          ) : (
            <Folder className="h-4 w-4 shrink-0 text-amber-500" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open &&
          sortedChildren(node).map((child) => (
            <TreeNodeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              dirtyPaths={dirtyPaths}
              onSelect={onSelect}
            />
          ))}
      </div>
    )
  }

  const isDirty = dirtyPaths.has(node.path)

  return (
    <button
      type="button"
      onClick={() => node.entry && onSelect(node.entry.path)}
      className={cn(
        'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-800',
        selectedPath === node.path
          ? 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300'
          : 'text-slate-700 dark:text-slate-300',
      )}
      style={{ paddingLeft: `${depth * 14 + 8 + 18}px` }}
    >
      <File className="h-4 w-4 shrink-0 text-slate-400" />
      <span className="truncate">{node.name}</span>
      {isDirty && (
        <span
          className="ml-auto h-2 w-2 shrink-0 rounded-full bg-amber-500"
          title="Unsaved changes"
        />
      )}
    </button>
  )
}

// ============================================================================
// Revision compare: the "which version" side of the dialog
// ============================================================================

function VersionPicker({
  versions,
  isLoading,
  isError,
  onPick,
}: {
  versions: Array<SoftwareVersion>
  isLoading: boolean
  isError: boolean
  onPick: (version: SoftwareVersion) => void
}) {
  if (isLoading) {
    return (
      <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        Loading versions...
      </p>
    )
  }

  if (isError) {
    return (
      <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">
        Could not load the other versions of this item.
      </p>
    )
  }

  if (versions.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
        No other versions of this item to compare against.
      </p>
    )
  }

  return (
    <div className="space-y-1">
      {versions.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onPick(v)}
          className="flex w-full items-center justify-between rounded border border-slate-200 px-3 py-2 text-left text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          <span className="font-mono">Rev {v.revision}</span>
          <span className="text-slate-500 dark:text-slate-400">
            {v.state}
            {v.isCurrent ? ' · current' : ''}
          </span>
        </button>
      ))}
    </div>
  )
}

// ============================================================================
// SourceViewer
// ============================================================================

export function SourceViewer({
  itemId,
  canImport = true,
  canEdit = false,
  onImported,
}: SourceViewerProps) {
  const { handleError, showSuccess } = useErrorHandler()
  const { confirm } = useAlertDialog()
  const invalidate = useInvalidateResources()

  // Which file the user is looking at. Selection is local; the file read
  // below follows it through the cache, so re-opening a file it already
  // holds costs nothing.
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [isImporting, setIsImporting] = useState(false)

  // Editing state: path -> edited content (differs from saved draft)
  const [dirtyFiles, setDirtyFiles] = useState<Map<string, string>>(new Map())
  const [isSavingDraft, setIsSavingDraft] = useState(false)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameTo, setRenameTo] = useState('')

  // Revision compare: which dialog is open and which version is the other
  // side. Both of the reads it needs hang off those two pieces of state.
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareFrom, setCompareFrom] = useState<SoftwareVersion | null>(null)
  const [diffTarget, setDiffTarget] = useState<SourceDiffTarget | null>(null)

  const zipInputRef = useRef<HTMLInputElement>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)

  const {
    data: tree,
    isPending: isLoadingTree,
    isError: treeFailed,
    refetch: refetchTree,
  } = useQuery(softwareTreeQuery(itemId, { draft: true }))

  const {
    data: fileContent,
    isLoading: isLoadingFile,
    isError: fileFailed,
  } = useQuery(softwareFileQuery(itemId, selectedPath, { draft: true }))

  const {
    data: versionList,
    isLoading: isLoadingVersions,
    isError: versionsFailed,
  } = useQuery(softwareVersionsQuery(itemId, compareOpen))

  const { data: compareChanges, isError: diffFailed } = useQuery(
    softwareDiffQuery(itemId, compareFrom?.id ?? null),
  )

  const hasDraft = !!tree?.draftManifestId
  const dirtyCount = dirtyFiles.size

  const rootNode = useMemo(
    () => (tree ? buildTree(tree.entries) : null),
    [tree],
  )

  // This item is always in the list the endpoint returns; it is the side
  // being compared against, not a candidate.
  const versions = useMemo(
    () => (versionList ?? []).filter((v) => v.id !== itemId),
    [versionList, itemId],
  )

  // --------------------------------------------------------------------------
  // Draft editing
  // --------------------------------------------------------------------------

  const markDirty = useCallback((path: string, content: string) => {
    setDirtyFiles((prev) => new Map(prev).set(path, content))
  }, [])

  /**
   * Flush every edited file into the draft tree.
   *
   * Stays imperative rather than moving to `useResourceMutation`: it is a
   * loop over one PUT per dirty file, and the callers (the Save button, the
   * auto-save interval, the commit flow) each need its boolean verdict
   * before deciding what to do next. Invalidation happens once, after the
   * whole batch, so a save does not restage the tree per file.
   */
  const saveDraft = useCallback(async (): Promise<boolean> => {
    if (dirtyFiles.size === 0) return true
    setIsSavingDraft(true)
    try {
      for (const [path, content] of dirtyFiles) {
        await apiFetch(`/api/v1/software/${itemId}/file`, {
          method: 'PUT',
          body: JSON.stringify({ path, content }),
        })
      }
      setDirtyFiles(new Map())
      await invalidate('software')
      return true
    } catch (error) {
      handleError(error, { title: 'Failed to save draft' })
      return false
    } finally {
      setIsSavingDraft(false)
    }
  }, [dirtyFiles, itemId, handleError, invalidate])

  // Auto-save dirty files every 30s (proposal §5.2). Nothing is dirty means
  // no interval at all, so an idle viewer never invalidates anything.
  useEffect(() => {
    if (!canEdit || dirtyFiles.size === 0) return
    const timer = setInterval(() => {
      void saveDraft()
    }, 30_000)
    return () => clearInterval(timer)
  }, [canEdit, dirtyFiles.size, saveDraft])

  const { mutate: commitSource, isPending: isCommitPending } =
    useResourceMutation<void, Error, string>({
      mutationFn: async (message) => {
        await apiFetch(`/api/v1/software/${itemId}/commit`, {
          method: 'POST',
          body: JSON.stringify({ message }),
        })
      },
      invalidates: ['software'],
      onSuccess: (_result, message) => {
        showSuccess('Changes committed', message)
        setCommitDialogOpen(false)
        setCommitMessage('')
        onImported?.()
      },
      onError: (error) => handleError(error, { title: 'Failed to commit' }),
    })

  const isCommitting = isSavingDraft || isCommitPending

  const handleCommit = useCallback(async () => {
    const message = commitMessage.trim()
    if (!message) return
    // Uncommitted edits belong in the commit, so they have to reach the draft
    // tree first; a failed save has already reported itself.
    const saved = await saveDraft()
    if (!saved) return
    commitSource(message)
  }, [commitMessage, saveDraft, commitSource])

  const { mutate: discardDraft } = useResourceMutation({
    mutationFn: async () => {
      await apiFetch(`/api/v1/software/${itemId}/draft/discard`, {
        method: 'POST',
      })
    },
    invalidates: ['software'],
    onSuccess: () => setDirtyFiles(new Map()),
    onError: (error) =>
      handleError(error, { title: 'Failed to discard draft' }),
  })

  const handleDiscard = useCallback(() => {
    confirm({
      title: 'Discard draft',
      description:
        'Throw away all uncommitted changes and return to the last committed tree?',
      actionLabel: 'Discard',
      cancelLabel: 'Keep editing',
      variant: 'destructive',
      onConfirm: () => {
        // Drop the selection before the write: a file that exists only in the
        // draft stops existing the moment the discard lands, and the
        // invalidation that follows would otherwise chase it.
        setSelectedPath(null)
        discardDraft()
      },
    })
  }, [confirm, discardDraft])

  const { mutate: createFile } = useResourceMutation<string, Error, string>({
    mutationFn: async (path) => {
      const result = await apiFetch<{ data: { path: string } }>(
        `/api/v1/software/${itemId}/file`,
        {
          method: 'PUT',
          body: JSON.stringify({ path, content: '' }),
        },
      )
      return result.data.path
    },
    invalidates: ['software'],
    onSuccess: (storedPath) => {
      setNewFileDialogOpen(false)
      setNewFilePath('')
      // Invalidation has already settled, so the tree holds the new file by
      // the time the selection points at it. Select the path the server
      // stored, not the one typed: it normalizes before writing the entry,
      // and a read of anything else 404s.
      setSelectedPath(storedPath)
    },
    onError: (error) => handleError(error, { title: 'Failed to create file' }),
  })

  const handleCreateFile = useCallback(() => {
    const path = newFilePath.trim()
    if (!path) return
    createFile(path)
  }, [newFilePath, createFile])

  const { mutate: renameFile } = useResourceMutation<
    string,
    Error,
    { fromPath: string; toPath: string }
  >({
    mutationFn: async ({ fromPath, toPath }) => {
      const result = await apiFetch<{ data: { path: string } }>(
        `/api/v1/software/${itemId}/file/rename`,
        {
          method: 'POST',
          body: JSON.stringify({ fromPath, toPath }),
        },
      )
      return result.data.path
    },
    invalidates: ['software'],
    onSuccess: (storedPath) => {
      setRenameDialogOpen(false)
      // Follow the file to its new name rather than dropping the user back to
      // an empty pane. The old path was deselected before the write, so no
      // read ever went after the name the server has just retired. The name
      // to follow is the one the server reports storing — a typed 'src\b.c'
      // becomes 'src/b.c' there, and only that spelling reads back.
      setSelectedPath(storedPath)
    },
    onError: (error) => handleError(error, { title: 'Failed to rename file' }),
  })

  const handleRename = useCallback(() => {
    const toPath = renameTo.trim()
    if (selectedPath === null || !toPath) return
    setSelectedPath(null)
    renameFile({ fromPath: selectedPath, toPath })
  }, [selectedPath, renameTo, renameFile])

  const { mutate: deleteFile } = useResourceMutation<void, Error, string>({
    mutationFn: async (path) => {
      await apiFetch(
        `/api/v1/software/${itemId}/file?path=${encodeURIComponent(path)}`,
        { method: 'DELETE' },
      )
    },
    invalidates: ['software'],
    onError: (error) => handleError(error, { title: 'Failed to delete file' }),
  })

  const handleDeleteFile = useCallback(() => {
    if (selectedPath === null) return
    const path = selectedPath
    confirm({
      title: 'Delete file',
      description: `Delete ${path} from the draft tree?`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: () => {
        setDirtyFiles((prev) => {
          const next = new Map(prev)
          next.delete(path)
          return next
        })
        setSelectedPath(null)
        deleteFile(path)
      },
    })
  }, [selectedPath, confirm, deleteFile])

  // --------------------------------------------------------------------------
  // Import (zip / files)
  // --------------------------------------------------------------------------

  const uploadFormData = useCallback(
    async (formData: FormData, successMessage: string) => {
      setIsImporting(true)
      try {
        // Raw fetch: apiFetch forces a JSON content-type, which breaks the
        // multipart boundary the browser must set for FormData.
        const response = await fetch(`/api/v1/software/${itemId}/files`, {
          method: 'POST',
          body: formData,
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as {
            error?: { message?: string }
          } | null
          throw new Error(
            body?.error?.message ?? `Import failed (${response.status})`,
          )
        }
        showSuccess('Source imported', successMessage)
        setSelectedPath(null)
        await invalidate('software')
        onImported?.()
      } catch (error) {
        handleError(error, { title: 'Failed to import source' })
      } finally {
        setIsImporting(false)
      }
    },
    [itemId, showSuccess, handleError, invalidate, onImported],
  )

  const handleZipSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (!file) return
      const formData = new FormData()
      formData.append('files', file, file.name)
      // A zip import replaces the whole tree - it IS the tree
      formData.append('replace', 'true')
      await uploadFormData(formData, `Imported ${file.name}`)
    },
    [uploadFormData],
  )

  const handleFilesSelected = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (!files || files.length === 0) return
      const formData = new FormData()
      for (const file of Array.from(files)) {
        const rel =
          (file as { webkitRelativePath?: string }).webkitRelativePath ||
          file.name
        formData.append('files', file, rel)
      }
      e.target.value = ''
      await uploadFormData(
        formData,
        `Imported ${files.length} file${files.length === 1 ? '' : 's'}`,
      )
    },
    [uploadFormData],
  )

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  const importButtons = canImport && !hasDraft && (
    <>
      <input
        ref={zipInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={handleZipSelected}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFilesSelected}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={isImporting}
        onClick={() => zipInputRef.current?.click()}
      >
        <FileArchive className="mr-2 h-4 w-4" />
        {isImporting ? 'Importing...' : 'Import zip'}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={isImporting}
        onClick={() => filesInputRef.current?.click()}
      >
        <Upload className="mr-2 h-4 w-4" />
        Add files
      </Button>
    </>
  )

  const editButtons = canEdit && (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setNewFileDialogOpen(true)}
      >
        <FilePlus className="mr-2 h-4 w-4" />
        New file
      </Button>
      {(dirtyCount > 0 || hasDraft) && (
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={isSavingDraft || dirtyCount === 0}
            onClick={() => void saveDraft()}
          >
            {isSavingDraft
              ? 'Saving...'
              : dirtyCount > 0
                ? `Save draft (${dirtyCount})`
                : 'Draft saved'}
          </Button>
          <Button size="sm" onClick={() => setCommitDialogOpen(true)}>
            <GitCommitHorizontal className="mr-2 h-4 w-4" />
            Commit
          </Button>
          {hasDraft && (
            <Button variant="outline" size="sm" onClick={handleDiscard}>
              <Undo2 className="mr-2 h-4 w-4" />
              Discard
            </Button>
          )}
        </>
      )}
    </>
  )

  if (isLoadingTree) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          Loading source tree...
        </CardContent>
      </Card>
    )
  }

  // A failed read used to fall through to the empty state below, which says
  // the item has no source at all — the opposite of "we could not tell".
  if (treeFailed && !tree) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <p className="text-sm text-red-600 dark:text-red-400">
            Could not load the source tree for this item.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetchTree()}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    )
  }

  // Past both guards the tree is loaded: a failed *first* read returned
  // above, and a failed refetch still has the previous tree to show.
  if (tree.entries.length === 0 && !hasDraft) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No source tree yet. Import a zip archive or individual files to get
            started.
          </p>
          <div className="flex gap-2">
            {importButtons}
            {editButtons}
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {tree.fileCount} {tree.fileCount === 1 ? 'file' : 'files'} ·{' '}
            {formatSize(tree.totalSize)}
          </p>
          {hasDraft && (
            <Badge variant="warning" className="text-xs">
              Draft — uncommitted changes
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCompareOpen(true)}
          >
            <FileDiff className="mr-2 h-4 w-4" />
            Compare
          </Button>
          {importButtons}
          {editButtons}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-4">
        {/* File tree sidebar */}
        <Card className="lg:col-span-1">
          <CardContent className="max-h-[70vh] overflow-auto p-2">
            {rootNode &&
              sortedChildren(rootNode).map((child) => (
                <TreeNodeRow
                  key={child.path}
                  node={child}
                  depth={0}
                  selectedPath={selectedPath}
                  dirtyPaths={new Set(dirtyFiles.keys())}
                  onSelect={setSelectedPath}
                />
              ))}
          </CardContent>
        </Card>

        {/* Content pane */}
        <Card className="lg:col-span-3">
          <CardContent className="p-0">
            {selectedPath === null ? (
              <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                Select a file to view {canEdit ? 'or edit ' : ''}its contents
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-700">
                  <span className="font-mono text-sm text-slate-700 dark:text-slate-300">
                    {selectedPath}
                    {dirtyFiles.has(selectedPath) && (
                      <span className="ml-2 text-amber-500">●</span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    {canEdit && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setRenameTo(selectedPath)
                            setRenameDialogOpen(true)
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={handleDeleteFile}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      </>
                    )}
                    {fileContent && (
                      <span className="text-xs text-slate-400">
                        {formatSize(fileContent.size)}
                      </span>
                    )}
                  </div>
                </div>
                {isLoadingFile ? (
                  <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                    Loading file...
                  </div>
                ) : fileFailed ? (
                  <div className="py-12 text-center text-sm text-red-600 dark:text-red-400">
                    Could not load this file.
                  </div>
                ) : fileContent?.isBinary ? (
                  <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                    Binary file ({formatSize(fileContent.size)}) - preview not
                    available
                  </div>
                ) : fileContent ? (
                  <CodeEditor
                    content={
                      dirtyFiles.get(fileContent.path) ?? fileContent.content
                    }
                    path={fileContent.path}
                    readOnly={!canEdit}
                    onChange={(doc) => markDirty(fileContent.path, doc)}
                  />
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Commit dialog */}
      <Dialog open={commitDialogOpen} onOpenChange={setCommitDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Commit source changes</DialogTitle>
          </DialogHeader>
          <Textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Describe the change (required)..."
            rows={3}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCommitDialogOpen(false)}
              disabled={isCommitting}
            >
              Cancel
            </Button>
            <Button
              onClick={handleCommit}
              disabled={isCommitting || !commitMessage.trim()}
            >
              {isCommitting ? 'Committing...' : 'Commit'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* New file dialog */}
      <Dialog open={newFileDialogOpen} onOpenChange={setNewFileDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
          </DialogHeader>
          <Input
            value={newFilePath}
            onChange={(e) => setNewFilePath(e.target.value)}
            placeholder="src/module.c"
            className="font-mono"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setNewFileDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleCreateFile} disabled={!newFilePath.trim()}>
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {selectedPath}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameTo}
            onChange={(e) => setRenameTo(e.target.value)}
            className="font-mono"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRenameDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button onClick={handleRename} disabled={!renameTo.trim()}>
              Rename
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revision compare dialog */}
      <Dialog
        open={compareOpen}
        onOpenChange={(open) => {
          setCompareOpen(open)
          // Reset the chosen side on close so neither read stays enabled
          // behind a dialog nobody is looking at.
          if (!open) setCompareFrom(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Compare revisions</DialogTitle>
          </DialogHeader>
          {!compareFrom ? (
            <VersionPicker
              versions={versions}
              isLoading={isLoadingVersions}
              isError={versionsFailed}
              onPick={setCompareFrom}
            />
          ) : diffFailed ? (
            <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">
              Could not compare against Rev {compareFrom.revision}.
            </p>
          ) : !compareChanges ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              Computing diff...
            </p>
          ) : compareChanges.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
              No source differences between Rev {compareFrom.revision} and this
              version.
            </p>
          ) : (
            <div className="max-h-[50vh] space-y-1 overflow-auto">
              {compareChanges.map((change) => (
                <button
                  key={change.path}
                  type="button"
                  onClick={() =>
                    setDiffTarget({
                      itemId,
                      path: change.path,
                      oldHash: change.oldHash ?? null,
                      newHash: change.newHash ?? null,
                      oldLabel: `Rev ${compareFrom.revision}`,
                      newLabel: 'This version',
                    })
                  }
                  className="flex w-full items-center gap-2 rounded px-3 py-1.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <Badge
                    variant={
                      change.status === 'added'
                        ? 'success'
                        : change.status === 'removed'
                          ? 'destructive'
                          : 'default'
                    }
                    className="w-20 justify-center text-xs"
                  >
                    {change.status}
                  </Badge>
                  <span className="truncate font-mono">{change.path}</span>
                </button>
              ))}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Per-file line diff */}
      <SourceDiffDialog
        target={diffTarget}
        onClose={() => setDiffTarget(null)}
      />
    </div>
  )
}
