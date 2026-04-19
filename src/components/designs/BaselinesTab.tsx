import { useMemo, useState } from 'react'
import { Download, Eye, GitCompare, Plus, Tag } from 'lucide-react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'

interface TagItem {
  id: string
  name: string
  tagType: string
  description?: string
  createdAt: string
  createdBy?: { id: string; name: string }
}

interface BaselinesTabProps {
  designId: string
  tags: Array<TagItem>
  versionContext: VersionContext
  isHistoricalView: boolean
  onViewBaseline: (tagId: string, tagName: string) => void
  onCreateBaseline?: () => void
}

export function BaselinesTab({
  tags,
  isHistoricalView,
  onViewBaseline,
  onCreateBaseline,
}: BaselinesTabProps) {
  const [compareFrom, setCompareFrom] = useState<string>('')
  const [compareTo, setCompareTo] = useState<string>('')

  // Sort tags by creation date (newest first)
  const sortedTags = useMemo(() => {
    return [...tags].sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )
  }, [tags])

  // Get tag type badge variant
  const getTagTypeBadgeVariant = (tagType: string) => {
    switch (tagType) {
      case 'baseline':
        return 'default' as const
      case 'release':
        return 'success' as const
      case 'milestone':
        return 'secondary' as const
      case 'eco-release':
        return 'warning' as const
      default:
        return 'outline' as const
    }
  }

  // Handle compare
  const handleCompare = () => {
    if (compareFrom && compareTo) {
      // TODO: Navigate to comparison view or open modal when API is implemented
      alert(
        `Comparing ${compareFrom} to ${compareTo}\n\nThis feature requires the comparison API to be implemented.`,
      )
    }
  }

  // Handle export
  const handleExport = (tag: TagItem) => {
    // TODO: Trigger BOM export at this baseline when API is implemented
    alert(
      `Exporting BOM at baseline ${tag.name}\n\nThis feature requires the export API to be implemented.`,
    )
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-end">
        {onCreateBaseline && (
          <Button onClick={onCreateBaseline} disabled={isHistoricalView}>
            <Plus className="h-4 w-4 mr-2" />
            Create Baseline
          </Button>
        )}
      </div>

      {/* Baselines Table */}
      <Card>
        <CardHeader>
          <CardTitle>Baselines & Tags</CardTitle>
          <CardDescription>
            {tags.length} {tags.length === 1 ? 'baseline' : 'baselines'} created
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sortedTags.length > 0 ? (
            <div className="border rounded-lg divide-y dark:border-slate-700 dark:divide-slate-700">
              {/* Header */}
              <div className="flex items-center gap-4 py-2 px-4 bg-slate-50 dark:bg-slate-800 text-sm font-medium text-slate-500 dark:text-slate-400">
                <div className="w-32">Name</div>
                <div className="w-24">Type</div>
                <div className="flex-1">Description</div>
                <div className="w-32">Created</div>
                <div className="w-48 text-right">Actions</div>
              </div>

              {/* Rows */}
              {sortedTags.map((tag) => (
                <div
                  key={tag.id}
                  className="flex items-center gap-4 py-3 px-4 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                  <div className="w-32 flex items-center gap-2">
                    <Tag className="h-4 w-4 text-blue-500" />
                    <span className="font-medium text-slate-900 dark:text-white">
                      {tag.name}
                    </span>
                  </div>
                  <div className="w-24">
                    <Badge
                      variant={getTagTypeBadgeVariant(tag.tagType)}
                      className="text-xs"
                    >
                      {tag.tagType}
                    </Badge>
                  </div>
                  <div className="flex-1 text-slate-600 dark:text-slate-400 truncate">
                    {tag.description || '-'}
                  </div>
                  <div className="w-32 text-sm text-slate-500">
                    {new Date(tag.createdAt).toLocaleDateString()}
                  </div>
                  <div className="w-48 flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onViewBaseline(tag.id, tag.name)}
                      title="View at this baseline"
                    >
                      <Eye className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setCompareFrom(tag.id)
                        // Scroll to compare section
                      }}
                      title="Compare to another baseline"
                    >
                      <GitCompare className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleExport(tag)}
                      title="Export BOM"
                    >
                      <Download className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-8 text-slate-500 dark:text-slate-400">
              No baselines or tags created yet. Create a baseline to capture the
              current configuration.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Baseline Comparison Tool */}
      {sortedTags.length >= 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <GitCompare className="h-5 w-5" />
              Compare Baselines
            </CardTitle>
            <CardDescription>
              Compare two baselines to see what changed
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4">
              <Select value={compareFrom} onValueChange={setCompareFrom}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="From baseline..." />
                </SelectTrigger>
                <SelectContent>
                  {sortedTags.map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>
                      {tag.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <span className="text-slate-400">to</span>

              <Select value={compareTo} onValueChange={setCompareTo}>
                <SelectTrigger className="w-48">
                  <SelectValue placeholder="To baseline..." />
                </SelectTrigger>
                <SelectContent>
                  {sortedTags.map((tag) => (
                    <SelectItem key={tag.id} value={tag.id}>
                      {tag.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                onClick={handleCompare}
                disabled={
                  !compareFrom || !compareTo || compareFrom === compareTo
                }
              >
                Compare
              </Button>
            </div>

            {compareFrom && compareTo && compareFrom === compareTo && (
              <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
                Please select two different baselines to compare.
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
