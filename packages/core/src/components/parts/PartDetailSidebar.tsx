// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type { Part } from '@/lib/items/types/part'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type { CADViewerState } from './useCADViewerState'
import { AttributesEditor } from '@/components/items/AttributesEditor'
import { FileList, FileUploadZone } from '@/components/vault'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  ViewEditStatic,
} from '@/components/ui'

/**
 * The right-hand column of a part's Details tab: custom attributes, the file
 * vault, and the row's own metadata.
 *
 * Three cards that share only their position. They are here rather than in
 * PartDetail because none of them participates in the page's edit/save cycle
 * beyond the two props below — the attributes editor writes through, and the
 * rest is display.
 */
export function PartDetailSidebar({
  part,
  isCreateMode,
  isEditing,
  isSubmitting,
  attributes,
  onAttributesChange,
  context,
  mainBranchId,
  cadViewer,
  onUploaded,
  onUploadError,
}: {
  /** The version-resolved part being displayed. */
  part: Part
  isCreateMode: boolean
  isEditing: boolean
  isSubmitting: boolean
  attributes: Record<string, string>
  onAttributesChange: (attributes: Record<string, string>) => void
  context: VersionContext
  mainBranchId: string | undefined
  /** Uploads refresh the CAD list and bust the thumbnail cache. */
  cadViewer: CADViewerState
  onUploaded: () => void
  onUploadError: (error: unknown) => void
}) {
  const branchId = context.type === 'branch' ? context.branchId : undefined

  return (
    <div className="space-y-6">
      {isEditing ? (
        <Card>
          <AttributesEditor
            value={attributes}
            onChange={onAttributesChange}
            disabled={isSubmitting}
            className="border-0 rounded-none"
          />
        </Card>
      ) : (
        <Card>
          <Collapsible
            defaultOpen={Object.keys(part.attributes ?? {}).length > 0}
          >
            <CardHeader className="pb-3">
              <CollapsibleTrigger className="hover:opacity-70">
                <CardTitle>Custom Attributes</CardTitle>
              </CollapsibleTrigger>
            </CardHeader>
            <CollapsibleContent>
              <CardContent className="pt-0">
                {Object.keys(part.attributes ?? {}).length > 0 ? (
                  <dl className="space-y-3">
                    {Object.entries(part.attributes ?? {}).map(
                      ([key, value]) => (
                        <div key={key} className="space-y-1">
                          <dt className="text-sm font-medium text-slate-500 dark:text-slate-400">
                            {key}
                          </dt>
                          <dd className="text-sm text-slate-900 dark:text-white bg-slate-100 dark:bg-slate-900 px-3 py-1.5 rounded-md">
                            {value || '-'}
                          </dd>
                        </div>
                      ),
                    )}
                  </dl>
                ) : (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    No custom attributes defined.
                  </p>
                )}
              </CardContent>
            </CollapsibleContent>
          </Collapsible>
        </Card>
      )}

      {!isCreateMode && part.id && (
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <FileUploadZone
              itemId={part.id}
              branchId={branchId ?? mainBranchId}
              onUploadComplete={onUploaded}
              onUploadError={onUploadError}
            />
            <FileList
              itemId={part.id}
              branchId={branchId}
              mainBranchId={mainBranchId}
              onViewCAD={cadViewer.showFile}
              onThumbnailChanged={cadViewer.bumpThumbnail}
            />
          </CardContent>
        </Card>
      )}

      <Collapsible defaultOpen={false}>
        <Card>
          <CardHeader>
            <CollapsibleTrigger className="hover:opacity-70">
              <CardTitle>Metadata</CardTitle>
            </CollapsibleTrigger>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="space-y-3">
              <ViewEditStatic
                label="Created"
                value={
                  part.createdAt
                    ? new Date(part.createdAt).toLocaleDateString()
                    : '-'
                }
              />
              <ViewEditStatic
                label="Last Modified"
                value={
                  part.modifiedAt
                    ? new Date(part.modifiedAt).toLocaleDateString()
                    : '-'
                }
              />
              {!isCreateMode && (
                <>
                  <ViewEditStatic
                    label="Master ID"
                    value={part.masterId}
                    mono
                  />
                  <ViewEditStatic label="Part ID" value={part.id} mono />
                </>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>
    </div>
  )
}
