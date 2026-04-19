import { useEffect, useState } from 'react'
import { ChevronDown, GitBranch, Tag } from 'lucide-react'
import {
  Badge,
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui'

interface Branch {
  id: string
  name: string
  branchType: 'main' | 'eco' | 'feature'
  isLocked?: boolean
  changeOrderNumber?: string
}

interface VersionTag {
  id: string
  name: string
  tagType: 'baseline' | 'release' | 'milestone' | 'eco-release'
  description?: string
}

interface VersionContextSelectorProps {
  designId: string
  currentBranchId?: string
  currentTagId?: string
  onVersionChange: (context: { branchId?: string; tagId?: string }) => void
  disabled?: boolean
}

export function VersionContextSelector({
  designId,
  currentBranchId,
  currentTagId,
  onVersionChange,
  disabled = false,
}: VersionContextSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [branches, setBranches] = useState<Array<Branch>>([])
  const [tags, setTags] = useState<Array<VersionTag>>([])
  const [isLoading, setIsLoading] = useState(false)

  useEffect(() => {
    async function fetchVersionContext() {
      if (!designId) return

      setIsLoading(true)
      try {
        const [branchesRes, tagsRes] = await Promise.all([
          fetch(`/api/designs/${designId}/branches`),
          fetch(`/api/designs/${designId}/tags`),
        ])

        if (branchesRes.ok) {
          const data = await branchesRes.json()
          setBranches(data.data?.branches || [])
        }

        if (tagsRes.ok) {
          const data = await tagsRes.json()
          setTags(data.data?.tags || [])
        }
      } catch {
        // Failed to load version context
      } finally {
        setIsLoading(false)
      }
    }

    fetchVersionContext()
  }, [designId])

  const currentBranch = branches.find((b) => b.id === currentBranchId)
  const currentTag = tags.find((t) => t.id === currentTagId)

  const getDisplayText = () => {
    if (currentTag) {
      return currentTag.name
    }
    if (currentBranch) {
      return currentBranch.name === 'main' ? 'main @ HEAD' : currentBranch.name
    }
    return 'main @ HEAD'
  }

  const handleSelectBranch = (branch: Branch) => {
    onVersionChange({ branchId: branch.id, tagId: undefined })
    setIsOpen(false)
  }

  const handleSelectTag = (tag: VersionTag) => {
    onVersionChange({ branchId: undefined, tagId: tag.id })
    setIsOpen(false)
  }

  const mainBranch = branches.find((b) => b.branchType === 'main')
  const ecoBranches = branches.filter(
    (b) => b.branchType === 'eco' && !b.isLocked,
  )
  const featureBranches = branches.filter((b) => b.branchType === 'feature')

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || isLoading}
          className="gap-2"
        >
          <GitBranch className="h-4 w-4" />
          <span className="font-medium">{getDisplayText()}</span>
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2" align="start">
        <div className="space-y-3">
          {/* Main Branch */}
          {mainBranch && (
            <div>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider px-2 mb-1">
                Main
              </p>
              <button
                onClick={() => handleSelectBranch(mainBranch)}
                className={`w-full flex items-center gap-2 p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${
                  currentBranchId === mainBranch.id && !currentTagId
                    ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300'
                    : ''
                }`}
              >
                <GitBranch className="h-4 w-4" />
                <span className="flex-1 text-left">main @ HEAD</span>
                <Badge variant="success" className="text-xs">
                  current
                </Badge>
              </button>
            </div>
          )}

          {/* ECO Branches */}
          {ecoBranches.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider px-2 mb-1">
                Active ECOs
              </p>
              {ecoBranches.map((branch) => (
                <button
                  key={branch.id}
                  onClick={() => handleSelectBranch(branch)}
                  className={`w-full flex items-center gap-2 p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${
                    currentBranchId === branch.id
                      ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300'
                      : ''
                  }`}
                >
                  <GitBranch className="h-4 w-4" />
                  <span className="flex-1 text-left">{branch.name}</span>
                  <Badge variant="warning" className="text-xs">
                    eco
                  </Badge>
                </button>
              ))}
            </div>
          )}

          {/* Feature Branches */}
          {featureBranches.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider px-2 mb-1">
                Feature Branches
              </p>
              {featureBranches.map((branch) => (
                <button
                  key={branch.id}
                  onClick={() => handleSelectBranch(branch)}
                  className={`w-full flex items-center gap-2 p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${
                    currentBranchId === branch.id
                      ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300'
                      : ''
                  }`}
                >
                  <GitBranch className="h-4 w-4" />
                  <span className="flex-1 text-left">{branch.name}</span>
                </button>
              ))}
            </div>
          )}

          {/* Tags/Baselines */}
          {tags.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider px-2 mb-1">
                Baselines & Tags
              </p>
              {tags.slice(0, 5).map((tag) => (
                <button
                  key={tag.id}
                  onClick={() => handleSelectTag(tag)}
                  className={`w-full flex items-center gap-2 p-2 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors ${
                    currentTagId === tag.id
                      ? 'bg-cyan-50 dark:bg-cyan-900/30 text-cyan-700 dark:text-cyan-300'
                      : ''
                  }`}
                >
                  <Tag className="h-4 w-4" />
                  <span className="flex-1 text-left">{tag.name}</span>
                  <Badge variant="secondary" className="text-xs">
                    {tag.tagType}
                  </Badge>
                </button>
              ))}
              {tags.length > 5 && (
                <p className="text-xs text-slate-400 text-center py-1">
                  +{tags.length - 5} more
                </p>
              )}
            </div>
          )}

          {branches.length === 0 && tags.length === 0 && !isLoading && (
            <p className="text-sm text-slate-500 text-center py-4">
              No version context available
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
