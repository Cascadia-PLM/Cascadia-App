// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Eye, EyeOff, GitCompare } from 'lucide-react'
import type { CADCompareState } from './useCADCompareState'
import type { CADViewerState } from './useCADViewerState'
import { CADComparePanel } from '@/components/parts/CADComparePanel'
import { CADFileSelect } from '@/components/parts/CADFileSelect'
import { CADViewerSurface } from '@/components/parts/CADViewerSurface'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
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
        <CADViewerSurface
          viewer={viewer}
          file={selectedFile}
          comparison={compare.comparison}
          onError={onError}
        >
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
        </CADViewerSurface>
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
