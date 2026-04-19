import { Link } from '@tanstack/react-router'
import {
  Archive,
  ArrowLeft,
  Copy,
  Edit,
  Factory,
  Save,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { QuickJumpPills } from './QuickJumpPills'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import type { Design } from '@/lib/types/design'
import type { Program } from '@/lib/types/program'
import { DesignPhaseIndicator } from '@/components/versioning/DesignPhaseIndicator'
import { VersionContextSelector } from '@/components/versioning/VersionContextSelector'
import { Badge, Button } from '@/components/ui'

interface Branch {
  id: string
  name: string
  branchType: string
  isArchived: boolean
  isLocked: boolean
  createdAt: string
}

interface TagItem {
  id: string
  name: string
  tagType: string
  description?: string
  createdAt: string
}

interface DesignWithDetails extends Design {
  defaultBranch?: Branch | null
  program?: Program | null
}

export interface DesignPageHeaderProps {
  design: DesignWithDetails
  branches: Array<Branch>
  tags: Array<TagItem>
  versionContext: VersionContext
  onContextChange: (context: VersionContext) => void
  isHistoricalView: boolean
  isEditing?: boolean
  isSaving?: boolean
  onEdit?: () => void
  onSave?: () => void
  onCancelEdit?: () => void
  onArchive?: () => void
  onClone?: () => void
  onReleaseToManufacturing?: () => void
  onGapAnalysis?: () => void
}

export function DesignPageHeader({
  design,
  tags,
  versionContext,
  onContextChange,
  isHistoricalView,
  isEditing,
  isSaving,
  onEdit,
  onSave,
  onCancelEdit,
  onArchive,
  onClone,
  onReleaseToManufacturing,
  onGapAnalysis,
}: DesignPageHeaderProps) {
  // Get context badge variant based on current view mode
  const getContextBadgeVariant = () => {
    switch (versionContext.type) {
      case 'main':
        return 'success' as const
      case 'branch':
        return 'warning' as const
      case 'tag':
        return 'secondary' as const
      case 'commit':
        return 'outline' as const
      default:
        return 'default' as const
    }
  }

  // Get context label for badge
  const getContextLabel = () => {
    switch (versionContext.type) {
      case 'main':
        return 'Main'
      case 'branch':
        return versionContext.branchName || 'Branch'
      case 'tag':
        return versionContext.tagName || 'Tag'
      case 'commit':
        return `Commit ${versionContext.commitId?.slice(0, 8)}`
      default:
        return 'Main'
    }
  }

  return (
    <div className="space-y-4">
      {/* Top row: Back button, title, actions */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link to="/designs">
            <Button variant="outline" size="icon">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-4xl font-bold text-slate-900 dark:text-white">
                {design.code}
              </h1>
              <Badge
                className="text-base"
                variant={
                  design.designType === 'Library' ? 'secondary' : 'default'
                }
              >
                {design.designType}
              </Badge>
              <Badge variant={getContextBadgeVariant()} className="text-sm">
                {getContextLabel()}
              </Badge>
              <DesignPhaseIndicator designId={design.id} />
            </div>
            <p className="text-slate-600 dark:text-slate-400 mt-1">
              {design.name}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          {/* Version Context Selector */}
          <VersionContextSelector
            designId={design.id}
            value={versionContext}
            onChange={onContextChange}
            disabled={false}
          />

          {isEditing ? (
            <>
              <Button
                variant="outline"
                onClick={onCancelEdit}
                disabled={isSaving}
              >
                <X className="h-4 w-4 mr-2" />
                Cancel
              </Button>
              <Button onClick={onSave} disabled={isSaving}>
                <Save className="h-4 w-4 mr-2" />
                {isSaving ? 'Saving...' : 'Save'}
              </Button>
            </>
          ) : (
            <>
              {/* Actions - disabled in historical view */}
              {onGapAnalysis && design.designType !== 'Family' && (
                <Button variant="outline" onClick={onGapAnalysis}>
                  <Search className="h-4 w-4 mr-2" />
                  Gap Analysis
                </Button>
              )}
              {onEdit && (
                <Button
                  variant="outline"
                  onClick={onEdit}
                  disabled={isHistoricalView}
                >
                  <Edit className="h-4 w-4 mr-2" />
                  Edit
                </Button>
              )}
              {onClone && design.designType === 'Engineering' && (
                <Button
                  variant="outline"
                  onClick={onClone}
                  disabled={isHistoricalView}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Clone
                </Button>
              )}
              {onReleaseToManufacturing &&
                design.designType === 'Engineering' && (
                  <Button
                    variant="default"
                    onClick={onReleaseToManufacturing}
                    disabled={isHistoricalView}
                  >
                    <Factory className="h-4 w-4 mr-2" />
                    Release to Manufacturing
                  </Button>
                )}
              {onArchive && design.designType !== 'Library' && (
                <Button
                  variant="outline"
                  onClick={onArchive}
                  disabled={isHistoricalView}
                >
                  <Archive className="h-4 w-4 mr-2" />
                  Archive
                </Button>
              )}
              <Button variant="ghost" size="icon">
                <Settings className="h-4 w-4" />
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Quick Jump Pills for recent tags */}
      {tags.length > 0 && (
        <QuickJumpPills
          tags={tags}
          currentTagId={
            versionContext.type === 'tag' ? versionContext.tagId : undefined
          }
          onTagClick={(tagId, tagName) =>
            onContextChange({ type: 'tag', tagId, tagName })
          }
        />
      )}
    </div>
  )
}
