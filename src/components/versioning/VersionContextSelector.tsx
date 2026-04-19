import { useEffect, useState } from 'react'
import { Check, ChevronDown, Clock, GitBranch, Tag } from 'lucide-react'
import type { VersionContext } from '@/lib/hooks/useVersionContext'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'
import { Badge } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface Branch {
  id: string
  name: string
  branchType: 'main' | 'eco' | 'workspace' | 'release'
  isArchived: boolean
  isLocked: boolean
  changeOrderItemId?: string
  ownerId?: string
  exists?: boolean // Used when filtering by item
}

interface Tag {
  id: string
  name: string
  tagType: string
  createdAt?: string
  exists?: boolean // Used when filtering by item
}

interface VersionContextSelectorProps {
  designId: string
  value?: VersionContext
  onChange: (context: VersionContext) => void
  disabled?: boolean
  className?: string
  showLabel?: boolean
  /** If set, only show branches/tags where this item exists */
  itemId?: string
  /** Visual style variant - 'default' for form-style select, 'breadcrumb' for minimal text style */
  variant?: 'default' | 'breadcrumb'
}

export function VersionContextSelector({
  designId,
  value,
  onChange,
  disabled = false,
  className,
  showLabel = false,
  itemId,
  variant = 'default',
}: VersionContextSelectorProps) {
  const [branches, setBranches] = useState<Array<Branch>>([])
  const [tags, setTags] = useState<Array<Tag>>([])
  const [loading, setLoading] = useState(true)

  // Fetch branches and tags when designId or itemId changes
  useEffect(() => {
    if (!designId) {
      setBranches([])
      setTags([])
      setLoading(false)
      return
    }

    async function fetchData() {
      setLoading(true)
      try {
        let fetchedBranches: Array<Branch> = []
        let fetchedTags: Array<Tag> = []

        if (itemId) {
          // Fetch available contexts filtered by item existence
          const res = await apiFetch<{
            data: {
              branches: Array<Branch>
              tags: Array<Tag>
            }
          }>(`/api/items/${itemId}/available-contexts`)
          // Only include contexts where item exists
          fetchedBranches = res.data.branches.filter((b) => b.exists !== false)
          fetchedTags = res.data.tags.filter((t) => t.exists !== false)
        } else {
          // Fetch all branches and tags (original behavior)
          const [branchesRes, tagsRes] = await Promise.all([
            apiFetch<{ data: { branches: Array<Branch> } }>(
              `/api/designs/${designId}/branches`,
            ),
            apiFetch<{ data: { tags: Array<Tag> } }>(
              `/api/designs/${designId}/tags`,
            ).catch(() => ({ data: { tags: [] } })),
          ])
          fetchedBranches = branchesRes.data.branches
          fetchedTags = tagsRes.data.tags
        }

        setBranches(fetchedBranches)
        setTags(fetchedTags)
      } catch {
        setBranches([])
        setTags([])
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [designId, itemId])

  // Auto-select a valid context when current selection is unavailable
  // This is separate from the fetch effect to properly react to value/branches changes
  useEffect(() => {
    // Only auto-select for item detail pages (when itemId is provided)
    // and when we have branches loaded (not in loading state)
    if (!itemId || loading || branches.length === 0) {
      return
    }

    const mainBranch = branches.find((b) => b.branchType === 'main')
    const isCurrentValid =
      (value?.type === 'main' && mainBranch) ||
      (value?.type === 'branch' &&
        branches.some((b) => b.id === value.branchId)) ||
      (value?.type === 'tag' && tags.some((t) => t.id === value.tagId))

    if (!isCurrentValid) {
      // Auto-select first available branch (prefer ECO, then workspace, then main)
      const ecoBranch = branches.find(
        (b) => b.branchType === 'eco' && !b.isArchived,
      )
      const workspaceBranch = branches.find(
        (b) => b.branchType === 'workspace' && !b.isArchived,
      )
      const firstBranch =
        ecoBranch || workspaceBranch || mainBranch || branches[0]

      // firstBranch is guaranteed to exist since branches.length > 0
      if (firstBranch.branchType === 'main') {
        onChange({ type: 'main' })
      } else {
        onChange({
          type: 'branch',
          branchId: firstBranch.id,
          branchName: firstBranch.name,
        })
      }
    }
  }, [itemId, loading, branches, tags, value, onChange])

  // Group branches by type
  const mainBranch = branches.find((b) => b.branchType === 'main')
  const ecoBranches = branches.filter(
    (b) => b.branchType === 'eco' && !b.isArchived,
  )
  const workspaceBranches = branches.filter(
    (b) => b.branchType === 'workspace' && !b.isArchived,
  )
  const releaseBranches = branches.filter(
    (b) => b.branchType === 'release' && !b.isArchived,
  )

  // Convert current value to select value
  const selectValue =
    value?.type === 'main'
      ? 'main'
      : value?.type === 'branch'
        ? `branch:${value.branchId}`
        : value?.type === 'tag'
          ? `tag:${value.tagId}`
          : value?.type === 'commit'
            ? `commit:${value.commitId}`
            : 'main'

  // Handle selection change
  const handleChange = (newValue: string) => {
    if (newValue === 'main') {
      onChange({ type: 'main' })
    } else if (newValue.startsWith('branch:')) {
      const branchId = newValue.replace('branch:', '')
      const branch = branches.find((b) => b.id === branchId)
      onChange({
        type: 'branch',
        branchId,
        branchName: branch?.name,
      })
    } else if (newValue.startsWith('tag:')) {
      const tagId = newValue.replace('tag:', '')
      const tag = tags.find((t) => t.id === tagId)
      onChange({
        type: 'tag',
        tagId,
        tagName: tag?.name,
      })
    }
  }

  // Get display label for current value
  const getDisplayLabel = () => {
    if (value?.type === 'main') return 'Main'
    if (value?.type === 'branch') {
      const branch = branches.find((b) => b.id === value.branchId)
      return branch?.name || 'Branch'
    }
    if (value?.type === 'tag') {
      const tag = tags.find((t) => t.id === value.tagId)
      return tag?.name || 'Tag'
    }
    if (value?.type === 'commit') {
      return `Commit ${value.commitId?.slice(0, 8)}`
    }
    return 'Main'
  }

  // Get icon for branch type
  const getBranchIcon = (branchType: string) => {
    switch (branchType) {
      case 'eco':
        return (
          <Badge variant="outline" className="text-xs mr-2">
            ECO
          </Badge>
        )
      case 'workspace':
        return (
          <Badge variant="secondary" className="text-xs mr-2">
            WS
          </Badge>
        )
      case 'release':
        return (
          <Badge variant="default" className="text-xs mr-2">
            REL
          </Badge>
        )
      default:
        return null
    }
  }

  // Handle selection for breadcrumb variant
  const handleBreadcrumbSelect = (
    type: 'main' | 'branch' | 'tag',
    id?: string,
  ) => {
    if (type === 'main') {
      onChange({ type: 'main' })
    } else if (type === 'branch' && id) {
      const branch = branches.find((b) => b.id === id)
      onChange({ type: 'branch', branchId: id, branchName: branch?.name })
    } else if (type === 'tag' && id) {
      const tag = tags.find((t) => t.id === id)
      onChange({ type: 'tag', tagId: id, tagName: tag?.name })
    }
  }

  if (loading) {
    if (variant === 'breadcrumb') {
      return (
        <div className={`flex items-center gap-1 ${className || ''}`}>
          <div className="h-4 w-16 animate-pulse bg-slate-200 dark:bg-slate-700 rounded" />
        </div>
      )
    }
    return (
      <div className={`flex items-center gap-2 ${className || ''}`}>
        {showLabel && <span className="text-sm text-slate-500">Version:</span>}
        <div className="h-9 w-48 animate-pulse bg-slate-200 dark:bg-slate-700 rounded-md" />
      </div>
    )
  }

  // Breadcrumb variant - minimal text style matching program/design dropdowns
  if (variant === 'breadcrumb') {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-1 text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors outline-none"
          disabled={disabled}
        >
          <GitBranch className="h-4 w-4" />
          <span className="font-medium text-slate-900 dark:text-white">
            {getDisplayLabel()}
          </span>
          <ChevronDown className="h-4 w-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64 max-h-80 overflow-y-auto"
        >
          {/* Main branch */}
          {mainBranch && (
            <>
              <DropdownMenuLabel className="text-xs text-slate-500">
                Main Branch
              </DropdownMenuLabel>
              <DropdownMenuItem
                onClick={() => handleBreadcrumbSelect('main')}
                className="cursor-pointer"
              >
                <Check className="h-4 w-4 text-green-500 mr-2" />
                <span>Main</span>
              </DropdownMenuItem>
            </>
          )}

          {/* ECO branches */}
          {ecoBranches.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-slate-500">
                Change Orders
              </DropdownMenuLabel>
              {ecoBranches.map((branch) => (
                <DropdownMenuItem
                  key={branch.id}
                  onClick={() => handleBreadcrumbSelect('branch', branch.id)}
                  className="cursor-pointer"
                >
                  {getBranchIcon(branch.branchType)}
                  <span>{branch.name}</span>
                  {branch.isLocked && (
                    <Badge variant="outline" className="text-xs ml-2">
                      Locked
                    </Badge>
                  )}
                </DropdownMenuItem>
              ))}
            </>
          )}

          {/* Workspace branches */}
          {workspaceBranches.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-slate-500">
                Workspaces
              </DropdownMenuLabel>
              {workspaceBranches.map((branch) => (
                <DropdownMenuItem
                  key={branch.id}
                  onClick={() => handleBreadcrumbSelect('branch', branch.id)}
                  className="cursor-pointer"
                >
                  {getBranchIcon(branch.branchType)}
                  <span>{branch.name}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          {/* Release branches */}
          {releaseBranches.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-slate-500">
                Release Branches
              </DropdownMenuLabel>
              {releaseBranches.map((branch) => (
                <DropdownMenuItem
                  key={branch.id}
                  onClick={() => handleBreadcrumbSelect('branch', branch.id)}
                  className="cursor-pointer"
                >
                  {getBranchIcon(branch.branchType)}
                  <span>{branch.name}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-slate-500">
                Baselines / Tags
              </DropdownMenuLabel>
              {tags.map((tag) => (
                <DropdownMenuItem
                  key={tag.id}
                  onClick={() => handleBreadcrumbSelect('tag', tag.id)}
                  className="cursor-pointer"
                >
                  <Tag className="h-4 w-4 text-blue-500 mr-2" />
                  <span>{tag.name}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }

  // Default variant - form-style select
  return (
    <div className={`flex items-center gap-2 ${className || ''}`}>
      {showLabel && <span className="text-sm text-slate-500">Version:</span>}
      <Select
        value={selectValue}
        onValueChange={handleChange}
        disabled={disabled}
      >
        <SelectTrigger className="w-56">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-slate-500" />
            <SelectValue>{getDisplayLabel()}</SelectValue>
          </div>
        </SelectTrigger>
        <SelectContent>
          {/* Main branch */}
          <SelectGroup>
            <SelectLabel className="flex items-center gap-2">
              <Check className="h-3 w-3" />
              Main Branch
            </SelectLabel>
            {mainBranch && (
              <SelectItem value="main">
                <div className="flex items-center gap-2">
                  <Check className="h-4 w-4 text-green-500" />
                  <span>Main</span>
                </div>
              </SelectItem>
            )}
          </SelectGroup>

          {/* ECO branches */}
          {ecoBranches.length > 0 && (
            <SelectGroup>
              <SelectLabel className="flex items-center gap-2">
                <GitBranch className="h-3 w-3" />
                Change Orders
              </SelectLabel>
              {ecoBranches.map((branch) => (
                <SelectItem key={branch.id} value={`branch:${branch.id}`}>
                  <div className="flex items-center gap-2">
                    {getBranchIcon(branch.branchType)}
                    <span>{branch.name}</span>
                    {branch.isLocked && (
                      <Badge variant="outline" className="text-xs ml-2">
                        Locked
                      </Badge>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          )}

          {/* Workspace branches */}
          {workspaceBranches.length > 0 && (
            <SelectGroup>
              <SelectLabel className="flex items-center gap-2">
                <Clock className="h-3 w-3" />
                Workspaces
              </SelectLabel>
              {workspaceBranches.map((branch) => (
                <SelectItem key={branch.id} value={`branch:${branch.id}`}>
                  <div className="flex items-center gap-2">
                    {getBranchIcon(branch.branchType)}
                    <span>{branch.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          )}

          {/* Release branches */}
          {releaseBranches.length > 0 && (
            <SelectGroup>
              <SelectLabel className="flex items-center gap-2">
                <GitBranch className="h-3 w-3" />
                Release Branches
              </SelectLabel>
              {releaseBranches.map((branch) => (
                <SelectItem key={branch.id} value={`branch:${branch.id}`}>
                  <div className="flex items-center gap-2">
                    {getBranchIcon(branch.branchType)}
                    <span>{branch.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          )}

          {/* Tags */}
          {tags.length > 0 && (
            <SelectGroup>
              <SelectLabel className="flex items-center gap-2">
                <Tag className="h-3 w-3" />
                Baselines / Tags
              </SelectLabel>
              {tags.map((tag) => (
                <SelectItem key={tag.id} value={`tag:${tag.id}`}>
                  <div className="flex items-center gap-2">
                    <Tag className="h-4 w-4 text-blue-500" />
                    <span>{tag.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectGroup>
          )}
        </SelectContent>
      </Select>
    </div>
  )
}
