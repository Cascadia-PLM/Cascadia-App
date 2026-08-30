// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCADViewerKeyboard } from './useCADViewerKeyboard'
import type { CADModelStats, CADViewerHandle } from './CADViewer'
import type {
  BackgroundPreset,
  MaterialPreset,
  StandardView,
} from './CADViewerTypes'
import type { CADFileEntry } from './cad-types'
import { itemCadFilesQuery } from '@/lib/query/options/item-files'

/**
 * Everything the 3D viewer needs to be driven, in one place.
 *
 * PartDetail held ten pieces of state, two refs, a fetch-in-effect, a
 * fullscreen listener and a keyboard-shortcut memo for this — a third of its
 * hooks, none of which the rest of the page reads. Extracting the state rather
 * than only the markup is what makes the section component a rendering
 * concern; the alternative is threading eleven props down and eleven setters
 * back up.
 *
 * The file list is a query, not a `fetch` in an effect, so an upload
 * invalidating `files` refreshes it — previously the list reloaded only when
 * the item or the version context changed, so a newly uploaded model did not
 * appear until the page was left and returned to.
 */
export interface CADViewerState {
  /** Every viewable CAD file reachable from the item, direct or inherited. */
  files: Array<CADFileEntry>
  /** The file the viewer is showing, or null when there is nothing to show. */
  selectedFile: CADFileEntry | null
  selectFile: (file: CADFileEntry) => void
  /**
   * Show a file by id, falling back to a minimal entry when it is not in
   * `files` — the file browser can open a model the CAD list does not carry.
   */
  showFile: (fileId: string, fileName: string) => void

  showViewer: boolean
  setShowViewer: (show: boolean) => void

  wireframe: boolean
  toggleWireframe: () => void
  showGrid: boolean
  toggleGrid: () => void
  fullscreen: boolean
  toggleFullscreen: () => void
  background: BackgroundPreset
  setBackground: (preset: BackgroundPreset) => void
  material: MaterialPreset
  setMaterial: (preset: MaterialPreset) => void

  modelStats: Partial<CADModelStats>
  onModelLoad: (stats: CADModelStats) => void

  viewerRef: React.RefObject<CADViewerHandle | null>
  containerRef: React.RefObject<HTMLDivElement | null>

  resetView: () => void
  download: () => void

  /** Bumped to bust the thumbnail image cache after an upload or a delete. */
  thumbnailVersion: number
  bumpThumbnail: () => void
  /** Re-read the CAD file list — after an upload, a delete or a check-in. */
  refreshFiles: () => void
}

export function useCADViewerState({
  itemId,
  branchId,
  mainBranchId,
  enabled,
}: {
  itemId: string | undefined
  branchId: string | undefined
  mainBranchId: string | undefined
  /** False in create mode, where there is no item to have files. */
  enabled: boolean
}): CADViewerState {
  const queryClient = useQueryClient()
  const options = useMemo(
    () =>
      itemCadFilesQuery<CADFileEntry>(
        itemId,
        { branchId, mainBranchId },
        enabled,
      ),
    [itemId, branchId, mainBranchId, enabled],
  )
  const { data: files = [] } = useQuery(options)

  const [selectedFile, setSelectedFile] = useState<CADFileEntry | null>(null)
  const [modelStats, setModelStats] = useState<Partial<CADModelStats>>({})
  const [showViewer, setShowViewer] = useState(true)
  const [wireframe, setWireframe] = useState(false)
  const [showGrid, setShowGrid] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [background, setBackground] = useState<BackgroundPreset>('dark')
  const [material, setMaterial] = useState<MaterialPreset>('default')
  const [thumbnailVersion, setThumbnailVersion] = useState(0)

  const viewerRef = useRef<CADViewerHandle>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // Follow the file list: keep the user's choice while it is still present,
  // otherwise pick the best default. Colour-bearing GLB first, because that
  // is the only format that renders per-face colour; then the part's own
  // primary model; then any primary; then whatever there is.
  useEffect(() => {
    setSelectedFile((current) => {
      if (current && files.some((f) => f.id === current.id)) return current
      return (
        files.find((f) => f.fileType === 'glb' && f.hasColors) ??
        files.find((f) => f.isPrimaryModel && f.source === 'direct') ??
        files.find((f) => f.isPrimaryModel) ??
        files.at(0) ??
        null
      )
    })
  }, [files])

  const showFile = useCallback(
    (fileId: string, fileName: string) => {
      const existing = files.find((f) => f.id === fileId)
      setSelectedFile(
        existing ?? {
          id: fileId,
          fileName,
          fileType: fileName.toLowerCase().split('.').pop() || '',
          isPrimaryModel: false,
          hasColors: false,
          source: 'direct',
          sourceItemId: itemId ?? '',
          sourceItemNumber: null,
        },
      )
      setShowViewer(true)
    },
    [files, itemId],
  )

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement) document.exitFullscreen()
    else container.requestFullscreen()
  }, [])

  // The browser owns fullscreen state — Escape exits without telling us.
  useEffect(() => {
    const onChange = () => {
      setFullscreen(!!document.fullscreenElement)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleWireframe = useCallback(() => {
    setWireframe((prev) => !prev)
  }, [])
  const toggleGrid = useCallback(() => {
    setShowGrid((prev) => !prev)
  }, [])

  const keyboardActions = useMemo(
    () => ({
      resetView: () => viewerRef.current?.resetView(),
      toggleWireframe,
      toggleFullscreen,
      toggleGrid,
      setView: (view: StandardView) => viewerRef.current?.setView(view),
    }),
    [toggleFullscreen, toggleWireframe, toggleGrid],
  )

  useCADViewerKeyboard(
    containerRef,
    keyboardActions,
    showViewer && !!selectedFile,
  )

  const download = useCallback(() => {
    if (selectedFile) {
      window.open(`/api/v1/files/${selectedFile.id}/download`, '_blank')
    }
  }, [selectedFile])

  const refreshFiles = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: options.queryKey })
  }, [queryClient, options.queryKey])

  return {
    files,
    selectedFile,
    selectFile: setSelectedFile,
    showFile,
    showViewer,
    setShowViewer,
    wireframe,
    toggleWireframe,
    showGrid,
    toggleGrid,
    fullscreen,
    toggleFullscreen,
    background,
    setBackground,
    material,
    setMaterial,
    modelStats,
    onModelLoad: setModelStats,
    viewerRef,
    containerRef,
    resetView: () => viewerRef.current?.resetView(),
    download,
    thumbnailVersion,
    bumpThumbnail: () => {
      setThumbnailVersion((v) => v + 1)
    },
    refreshFiles,
  }
}
