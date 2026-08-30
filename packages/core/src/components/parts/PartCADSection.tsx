// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Eye, EyeOff, GitCompare } from 'lucide-react'
import type { CADFileEntry } from './cad-types'
import type { CADCompareState } from './useCADCompareState'
import type { CADViewerState } from './useCADViewerState'
import { CADViewer } from '@/components/parts/CADViewer'
import { CADComparePanel } from '@/components/parts/CADComparePanel'
import { CADViewerToolbar } from '@/components/parts/CADViewerToolbar'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

/**
 * The 3D model card on a part's detail page, plus the collapsed prompt that
 * takes its place when the viewer is hidden.
 *
 * Rendering only: both pieces of state it reads — the viewer's and the
 * comparison's — are owned by hooks a level up, because the page's file
 * uploader and thumbnail need the same viewer state and the comparison needs
 * the viewer's selected file to seed itself.
 */
export function PartCADSection({
  viewer,
  compare,
  onError,
}: {
  viewer: CADViewerState
  compare: CADCompareState
  onError: (error: unknown, options: { title: string }) => void
}) {
  const { selectedFile } = viewer
  const files = viewer.files

  if (!selectedFile || !viewer.showViewer) return null

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle>3D CAD Model</CardTitle>
            <CardDescription>
              {compare.isOpen ? (
                'Comparing two versions — pick each side in the panel'
              ) : (
                <>
                  Interactive 3D visualization • {selectedFile.fileName}
                  {selectedFile.source === 'cad_doc' &&
                    selectedFile.sourceItemNumber &&
                    ` (from ${selectedFile.sourceItemNumber})`}
                </>
              )}
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {files.length > 1 && !compare.isOpen && (
              <CADFileSelect
                files={files}
                selectedId={selectedFile.id}
                onSelect={viewer.selectFile}
              />
            )}
            <Button
              variant={compare.isOpen ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => {
                if (compare.isOpen) compare.close()
                else compare.open()
              }}
              title="Compare two versions of this part"
            >
              <GitCompare className="h-4 w-4 mr-2" />
              Compare
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => viewer.setShowViewer(false)}
              title="Hide 3D viewer"
            >
              <EyeOff className="h-4 w-4 mr-2" />
              Hide Viewer
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-0">
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
            hasEmbeddedColors={
              selectedFile.hasColors && selectedFile.fileType === 'glb'
            }
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
            fileUrl={`/api/v1/files/${selectedFile.id}/download`}
            fileType={selectedFile.fileType}
            fileName={selectedFile.fileName}
            wireframe={viewer.wireframe}
            showGrid={viewer.showGrid}
            backgroundPreset={viewer.background}
            materialPreset={viewer.material}
            hasEmbeddedColors={
              selectedFile.hasColors && selectedFile.fileType === 'glb'
            }
            comparison={compare.comparison}
            onLoad={viewer.onModelLoad}
            onError={(error) =>
              onError(error, { title: 'Failed to load CAD model' })
            }
            onComparisonError={(error) =>
              onError(error, { title: 'Failed to load a model being compared' })
            }
          />
          {compare.isOpen && (
            <CADComparePanel
              versions={compare.versions}
              isLoading={compare.isLoading}
              a={compare.a}
              b={compare.b}
              onChange={compare.onChange}
              onSwap={compare.onSwap}
              onClose={compare.close}
            />
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The card that replaces the viewer once it is hidden, so a part with models
 * never looks like a part without them.
 */
export function PartCADHiddenPrompt({ viewer }: { viewer: CADViewerState }) {
  const { files } = viewer
  if (files.length === 0 || viewer.showViewer) return null

  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-slate-900 dark:text-white">
              3D CAD Model Available
            </p>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {files.length} viewable CAD{' '}
              {files.length === 1 ? 'file' : 'files'}
              {files.some((f) => f.source === 'cad_doc')
                ? ' (includes related documents)'
                : ' attached'}
            </p>
          </div>
          <Button
            variant="default"
            onClick={() => viewer.setShowViewer(true)}
            title="Show 3D viewer"
          >
            <Eye className="h-4 w-4 mr-2" />
            Show 3D Viewer
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** Direct files first, then one group per CAD document they came from. */
function CADFileSelect({
  files,
  selectedId,
  onSelect,
}: {
  files: Array<CADFileEntry>
  selectedId: string
  onSelect: (file: CADFileEntry) => void
}) {
  const direct = files.filter((f) => f.source === 'direct')
  const docGroups = new Map<string, Array<CADFileEntry>>()
  for (const f of files.filter((cf) => cf.source === 'cad_doc')) {
    const key = f.sourceItemNumber ?? f.sourceItemId
    const group = docGroups.get(key)
    if (group) group.push(f)
    else docGroups.set(key, [f])
  }

  return (
    <Select
      value={selectedId}
      onValueChange={(fileId) => {
        const file = files.find((f) => f.id === fileId)
        if (file) onSelect(file)
      }}
    >
      <SelectTrigger className="w-[220px] h-8 text-xs" aria-label="CAD file">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {direct.length > 0 && (
          <SelectGroup>
            <SelectLabel>Direct Files</SelectLabel>
            {direct.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.fileName}
              </SelectItem>
            ))}
          </SelectGroup>
        )}
        {Array.from(docGroups.entries()).map(([label, groupFiles]) => (
          <SelectGroup key={label}>
            <SelectLabel>{label}</SelectLabel>
            {groupFiles.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                {f.fileName}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  )
}
