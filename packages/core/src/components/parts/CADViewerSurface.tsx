// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { CADViewer } from './CADViewer'
import { CADViewerToolbar } from './CADViewerToolbar'
import type { CADComparison } from './CADViewer'
import type { CADFileEntry } from './cad-types'
import type { CADViewerState } from './useCADViewerState'

/**
 * The viewport itself: the focusable container, its floating toolbar, and the
 * canvas that draws the model.
 *
 * Extracted from `PartCADSection` when the design and program pages grew
 * viewers of their own. The three differ only in how they arrive at a file —
 * a part's own attachments, a top-level part picked out of a design's
 * structure, a design picked out of a program — and in nothing below that
 * choice, so the choosing stays with the caller and the drawing lives here.
 */
export function CADViewerSurface({
  viewer,
  file,
  comparison = null,
  onError,
  children,
}: {
  viewer: CADViewerState
  /**
   * The model to draw. Passed rather than read off `viewer.selectedFile` so
   * the caller does the narrowing once, where it already decides whether
   * there is anything to show.
   */
  file: CADFileEntry
  comparison?: CADComparison | null
  onError: (error: unknown, options: { title: string }) => void
  /** Overlays drawn inside the viewport — the comparison panel, today. */
  children?: React.ReactNode
}) {
  return (
    <div
      ref={viewer.containerRef}
      className={`relative ${viewer.fullscreen ? 'h-screen' : 'h-[500px]'}`}
      tabIndex={0}
    >
      <CADViewerToolbar
        wireframe={viewer.wireframe}
        showGrid={viewer.showGrid}
        isFullscreen={viewer.fullscreen}
        backgroundPreset={viewer.background}
        materialPreset={viewer.material}
        polygonCount={viewer.modelStats.polygonCount}
        hasEmbeddedColors={file.hasColors && file.fileType === 'glb'}
        onResetView={viewer.resetView}
        onToggleWireframe={viewer.toggleWireframe}
        onToggleGrid={viewer.toggleGrid}
        onToggleFullscreen={viewer.toggleFullscreen}
        onBackgroundChange={viewer.setBackground}
        onMaterialChange={viewer.setMaterial}
        onDownload={viewer.download}
      />
      <CADViewer
        ref={viewer.viewerRef}
        fileUrl={`/api/v1/files/${file.id}/download`}
        fileType={file.fileType}
        fileName={file.fileName}
        wireframe={viewer.wireframe}
        showGrid={viewer.showGrid}
        backgroundPreset={viewer.background}
        materialPreset={viewer.material}
        hasEmbeddedColors={file.hasColors && file.fileType === 'glb'}
        comparison={comparison}
        onLoad={viewer.onModelLoad}
        onError={(error) =>
          onError(error, { title: 'Failed to load CAD model' })
        }
        onComparisonError={(error) =>
          onError(error, { title: 'Failed to load a model being compared' })
        }
      />
      {children}
    </div>
  )
}
