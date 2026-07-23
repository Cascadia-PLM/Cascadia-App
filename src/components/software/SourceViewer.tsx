import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  File,
  FileArchive,
  Folder,
  FolderOpen,
  Upload,
} from 'lucide-react'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { cpp } from '@codemirror/lang-cpp'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { oneDark } from '@codemirror/theme-one-dark'
import type { Extension } from '@codemirror/state'
import { Button, Card, CardContent } from '@/components/ui'
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

interface SourceViewerProps {
  itemId: string
  /** Show the import affordance (server still enforces branch protection) */
  canImport?: boolean
  /** Called after a successful import so the parent can refresh item data */
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
// CodeMirror language selection
// ============================================================================

function languageFor(path: string): Extension | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const name = path.split('/').pop()?.toLowerCase() ?? ''
  switch (ext) {
    case 'c':
    case 'h':
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
    case 'hh':
    case 'ino':
      return cpp()
    case 'py':
      return python()
    case 'json':
      return json()
    case 'yml':
    case 'yaml':
      return yaml()
    case 'md':
    case 'markdown':
      return markdown()
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript()
    case 'ts':
    case 'tsx':
      return javascript({ typescript: true, jsx: ext === 'tsx' })
    default:
      if (name === 'makefile' || name === 'cmakelists.txt') return null
      return null
  }
}

function CodeView({ content, path }: { content: string; path: string }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const isDark = document.documentElement.classList.contains('dark')
    const extensions: Array<Extension> = [
      basicSetup,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.theme({
        '&': { fontSize: '13px' },
        '.cm-scroller': { fontFamily: 'ui-monospace, monospace' },
      }),
    ]
    const lang = languageFor(path)
    if (lang) extensions.push(lang)
    if (isDark) extensions.push(oneDark)

    const view = new EditorView({
      state: EditorState.create({ doc: content, extensions }),
      parent: containerRef.current,
    })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [content, path])

  return <div ref={containerRef} className="max-h-[70vh] overflow-auto" />
}

// ============================================================================
// Tree rendering
// ============================================================================

function TreeNodeRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: TreeNode
  depth: number
  selectedPath: string | null
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
              onSelect={onSelect}
            />
          ))}
      </div>
    )
  }

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
    </button>
  )
}

// ============================================================================
// SourceViewer
// ============================================================================

export function SourceViewer({
  itemId,
  canImport = true,
  onImported,
}: SourceViewerProps) {
  const { handleError, showSuccess } = useErrorHandler()

  const [tree, setTree] = useState<TreeResponse | null>(null)
  const [isLoadingTree, setIsLoadingTree] = useState(true)
  const [selected, setSelected] = useState<ManifestEntry | null>(null)
  const [fileContent, setFileContent] = useState<FileResponse['file'] | null>(
    null,
  )
  const [isLoadingFile, setIsLoadingFile] = useState(false)
  const [isImporting, setIsImporting] = useState(false)

  const zipInputRef = useRef<HTMLInputElement>(null)
  const filesInputRef = useRef<HTMLInputElement>(null)

  const loadTree = useCallback(async () => {
    setIsLoadingTree(true)
    try {
      const result = await apiFetch<{ data: TreeResponse }>(
        `/api/v1/software/${itemId}/tree`,
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
          `/api/v1/software/${itemId}/file?path=${encodeURIComponent(entry.path)}`,
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
        // webkitRelativePath is set for directory picks; fall back to name
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

  const importButtons = canImport && (
    <div className="flex gap-2">
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
    </div>
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

  if (!tree || tree.entries.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-4 py-12">
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No source tree yet. Import a zip archive or individual files to
            get started.
          </p>
          {importButtons}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {tree.fileCount} {tree.fileCount === 1 ? 'file' : 'files'} ·{' '}
          {formatSize(tree.totalSize)}
        </p>
        {importButtons}
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
                Select a file to view its contents
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-700">
                  <span className="font-mono text-sm text-slate-700 dark:text-slate-300">
                    {selected.path}
                  </span>
                  <span className="text-xs text-slate-400">
                    {formatSize(selected.size)}
                  </span>
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
                  <CodeView
                    content={fileContent.content}
                    path={fileContent.path}
                  />
                ) : null}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
