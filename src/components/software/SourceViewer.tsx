import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { cn } from '@/lib/utils'

// ============================================================================
// Types
// ============================================================================

interface ManifestEntry {
  path: string
  hash: string
  size: number
}

interface TreeResponse {
  itemId: string
  revision: string
  manifestId: string | null
  draftManifestId: string | null
  isDraft: boolean
  fileCount: number
  totalSize: number
  entries: Array<ManifestEntry>
}

interface FileResponse {
  file: {
    path: string
    hash: string
    size: number
    isBinary: boolean
    content: string
    encoding: 'utf8' | 'base64'
  }
}

interface VersionInfo {
  id: string
  revision: string
  state: string
  isCurrent: boolean | null
  modifiedAt: string
  manifestId: string | null
}

interface DiffChange {
  path: string
  status: 'added' | 'removed' | 'modified'
  oldHash?: string
  newHash?: string
}

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
  entry?: ManifestEntry
}

function buildTree(entries: Array<ManifestEntry>): TreeNode {
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
    // is the initial doc, not a controlled value.
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
  onSelect: (entry: ManifestEntry) => void
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
      onClick={() => node.entry && onSelect(node.entry)}
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

  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [isLoadingTree, setIsLoadingTree] = useState(true)
  const [selected, setSelected] = useState<ManifestEntry | null>(null)
  const [fileContent, setFileContent] = useState<FileResponse['file'] | null>(
    null,
  )
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isImporting, setIsImporting] = useState(false)

  // Editing state: path -> edited content (differs from saved draft)
  const [dirtyFiles, setDirtyFiles] = useState<Map<string, string>>(new Map())
  const [isSavingDraft, setIsSavingDraft] = useState(false)
  const [commitDialogOpen, setCommitDialogOpen] = useState(false)
  const [commitMessage, setCommitMessage] = useState('')
  const [isCommitting, setIsCommitting] = useState(false)
  const [newFileDialogOpen, setNewFileDialogOpen] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameTo, setRenameTo] = useState('')

  // Revision compare state
  const [versions, setVersions] = useState<Array<VersionInfo>>([])
  const [compareOpen, setCompareOpen] = useState(false)
  const [compareFrom, setCompareFrom] = useState<VersionInfo | null>(null)
  const [compareChanges, setCompareChanges] = useState<Array<DiffChange> | null>(
    null,
  )
  const [diffTarget, setDiffTarget] = useState<SourceDiffTarget | null>(null)

  const zipInputRef = useRef<HTMLInputElement>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)

  const hasDraft = !!tree?.draftManifestId
  const dirtyCount = dirtyFiles.size

  const loadTree = useCallback(async () => {
    setIsLoadingTree(true)
    try {
      const result = await apiFetch<{ data: TreeResponse }>(
        `/api/v1/software/${itemId}/tree?draft=true`,
      )
      setTree(result.data)
    } catch (error) {
      handleError(error, { title: 'Failed to load source tree' })
    } finally {
      setIsLoadingTree(false)
    }
  }, [itemId, handleError])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  const rootNode = useMemo(
    () => (tree ? buildTree(tree.entries) : null),
    [tree],
  )

  const handleSelect = useCallback(
    async (entry: ManifestEntry) => {
      setSelected(entry)
      setIsLoadingFile(true)
      setFileContent(null)
      try {
        const result = await apiFetch<{ data: FileResponse }>(
          `/api/v1/software/${itemId}/file?path=${encodeURIComponent(entry.path)}&draft=true`,
        )
        setFileContent(result.data.file)
      } catch (error) {
        handleError(error, { title: 'Failed to load file' })
      } finally {
        setIsLoadingFile(false)
      }
    },
    [itemId, handleError],
  )

  // --------------------------------------------------------------------------
  // Draft editing
  // --------------------------------------------------------------------------

  const markDirty = useCallback((path: string, content: string) => {
    setDirtyFiles((prev) => new Map(prev).set(path, content))
  }, [])

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
      await loadTree()
      return true
    } catch (error) {
      handleError(error, { title: 'Failed to save draft' })
      return false
    } finally {
      setIsSavingDraft(false)
    }
  }, [dirtyFiles, itemId, handleError, loadTree])

  // Auto-save dirty files every 30s (proposal §5.2)
  useEffect(() => {
    if (!canEdit || dirtyFiles.size === 0) return
    const timer = setInterval(() => {
      void saveDraft()
    }, 30_000)
    return () => clearInterval(timer)
  }, [canEdit, dirtyFiles.size, saveDraft])

  const handleCommit = useCallback(async () => {
    if (!commitMessage.trim()) return
    setIsCommitting(true)
    try {
      const saved = await saveDraft()
      if (!saved) return
      await apiFetch(`/api/v1/software/${itemId}/commit`, {
        method: 'POST',
        body: JSON.stringify({ message: commitMessage.trim() }),
      })
      showSuccess('Changes committed', commitMessage.trim())
      setCommitDialogOpen(false)
      setCommitMessage('')
      await loadTree()
      onImported?.()
    } catch (error) {
      handleError(error, { title: 'Failed to commit' })
    } finally {
      setIsCommitting(false)
    }
  }, [
    commitMessage,
    saveDraft,
    itemId,
    showSuccess,
    loadTree,
    onImported,
    handleError,
  ])

  const handleDiscard = useCallback(() => {
    confirm({
      title: 'Discard draft',
      description:
        'Throw away all uncommitted changes and return to the last committed tree?',
      actionLabel: 'Discard',
      cancelLabel: 'Keep editing',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/v1/software/${itemId}/draft/discard`, {
            method: 'POST',
          })
          setDirtyFiles(new Map())
          setSelected(null)
          setFileContent(null)
          await loadTree()
        } catch (error) {
          handleError(error, { title: 'Failed to discard draft' })
        }
      },
    })
  }, [confirm, itemId, loadTree, handleError])

  const handleCreateFile = useCallback(async () => {
    const path = newFilePath.trim()
    if (!path) return
    try {
      await apiFetch(`/api/v1/software/${itemId}/file`, {
        method: 'PUT',
        body: JSON.stringify({ path, content: '' }),
      })
      setNewFileDialogOpen(false)
      setNewFilePath('')
      await loadTree()
      await handleSelect({ path, hash: '', size: 0 })
    } catch (error) {
      handleError(error, { title: 'Failed to create file' })
    }
  }, [newFilePath, itemId, loadTree, handleSelect, handleError])

  const handleRename = useCallback(async () => {
    if (!selected || !renameTo.trim()) return
    try {
      await apiFetch(`/api/v1/software/${itemId}/file/rename`, {
        method: 'POST',
        body: JSON.stringify({ fromPath: selected.path, toPath: renameTo }),
      })
      setRenameDialogOpen(false)
      setSelected(null)
      setFileContent(null)
      await loadTree()
    } catch (error) {
      handleError(error, { title: 'Failed to rename file' })
    }
  }, [selected, renameTo, itemId, loadTree, handleError])

  const handleDeleteFile = useCallback(() => {
    if (!selected) return
    confirm({
      title: 'Delete file',
      description: `Delete ${selected.path} from the draft tree?`,
      actionLabel: 'Delete',
      cancelLabel: 'Cancel',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await apiFetch(
            `/api/v1/software/${itemId}/file?path=${encodeURIComponent(selected.path)}`,
            { method: 'DELETE' },
          )
          setDirtyFiles((prev) => {
            const next = new Map(prev)
            next.delete(selected.path)
            return next
          })
          setSelected(null)
          setFileContent(null)
          await loadTree()
        } catch (error) {
          handleError(error, { title: 'Failed to delete file' })
        }
      },
    })
  }, [selected, confirm, itemId, loadTree, handleError])

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
        setSelected(null)
        setFileContent(null)
        await loadTree()
        onImported?.()
      } catch (error) {
        handleError(error, { title: 'Failed to import source' })
      } finally {
        setIsImporting(false)
      }
    },
    [itemId, showSuccess, handleError, loadTree, onImported],
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
  // Revision compare
  // --------------------------------------------------------------------------

  const openCompare = useCallback(async () => {
    setCompareOpen(true)
    setCompareFrom(null)
    setCompareChanges(null)
    try {
      const result = await apiFetch<{ data: { versions: Array<VersionInfo> } }>(
        `/api/v1/software/${itemId}/versions`,
      )
      setVersions(result.data.versions.filter((v) => v.id !== itemId))
    } catch (error) {
      handleError(error, { title: 'Failed to load versions' })
    }
  }, [itemId, handleError])

  const selectCompareFrom = useCallback(
    async (version: VersionInfo) => {
      setCompareFrom(version)
      setCompareChanges(null)
      try {
        const result = await apiFetch<{
          data: { changes: Array<DiffChange> }
        }>(`/api/v1/software/${itemId}/diff?fromItemId=${version.id}`)
        setCompareChanges(result.data.changes)
      } catch (error) {
        handleError(error, { title: 'Failed to compute diff' })
      }
    },
    [itemId, handleError],
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

  if (isLoadingTree && !tree) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
          Loading source tree...
        </CardContent>
      </Card>
    )
  }

  if (!tree || (tree.entries.length === 0 && !hasDraft)) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No source tree yet. Import a zip archive or individual files to
            get started.
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
          <Button variant="outline" size="sm" onClick={openCompare}>
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
                  selectedPath={selected?.path ?? null}
                  dirtyPaths={new Set(dirtyFiles.keys())}
                  onSelect={handleSelect}
                />
              ))}
          </CardContent>
        </Card>

        {/* Content pane */}
        <Card className="lg:col-span-3">
          <CardContent className="p-0">
            {!selected ? (
              <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                Select a file to view {canEdit ? 'or edit ' : ''}its contents
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-700">
                  <span className="font-mono text-sm text-slate-700 dark:text-slate-300">
                    {selected.path}
                    {dirtyFiles.has(selected.path) && (
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
                            setRenameTo(selected.path)
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
                    <span className="text-xs text-slate-400">
                      {formatSize(selected.size)}
                    </span>
                  </div>
                </div>
                {isLoadingFile ? (
                  <div className="py-12 text-center text-sm text-slate-500 dark:text-slate-400">
                    Loading file...
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
            <DialogTitle>Rename {selected?.path}</DialogTitle>
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
      <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Compare revisions</DialogTitle>
          </DialogHeader>
          {!compareFrom ? (
            versions.length === 0 ? (
              <p className="py-6 text-center text-sm text-slate-500 dark:text-slate-400">
                No other versions of this item to compare against.
              </p>
            ) : (
              <div className="space-y-1">
                {versions.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => void selectCompareFrom(v)}
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
