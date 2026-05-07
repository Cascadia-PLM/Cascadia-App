import { useEffect, useState } from 'react'
import { AlertCircle, Building2, FolderKanban, GitBranch } from 'lucide-react'
import type { ImportContext, ImportItemType } from '@/lib/import'
import { getImportConfig } from '@/lib/import'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select'
import { Badge, FormField } from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface Program {
  id: string
  name: string
  code: string
  status: string
}

interface Design {
  id: string
  name: string
  code: string
  programId: string
  designType: string
}

interface Branch {
  id: string
  name: string
  branchType: 'main' | 'eco' | 'workspace' | 'release'
  isLocked: boolean
}

interface DesignStatus {
  protection: {
    isMainBranchProtected: boolean
    phase: 'pre-release' | 'post-release'
  }
}

interface ContextSelectStepProps {
  itemType?: ImportItemType
  initialProgramId?: string
  initialDesignId?: string
  initialBranchId?: string
  value: ImportContext | null // Used by parent to track context state
  onChange: (context: ImportContext | null) => void
}

/**
 * Step 1: Select Program, Design, and optionally Branch for import context.
 * For Issues, only optional program selection is shown (no design/branch).
 */
export function ContextSelectStep({
  itemType = 'Part',
  initialProgramId,
  initialDesignId,
  initialBranchId,
  value: _value, // Used by parent to track context state
  onChange,
}: ContextSelectStepProps) {
  const config = getImportConfig(itemType)
  const requiresDesign = config.requiresDesign

  const [programs, setPrograms] = useState<Array<Program>>([])
  const [designs, setDesigns] = useState<Array<Design>>([])
  const [branches, setBranches] = useState<Array<Branch>>([])
  const [loadingPrograms, setLoadingPrograms] = useState(true)
  const [loadingDesigns, setLoadingDesigns] = useState(false)
  const [loadingBranches, setLoadingBranches] = useState(false)

  const [selectedProgramId, setSelectedProgramId] = useState<
    string | undefined
  >(initialProgramId)
  const [selectedDesignId, setSelectedDesignId] = useState<string | undefined>(
    initialDesignId,
  )
  const [selectedBranchId, setSelectedBranchId] = useState<string | undefined>(
    initialBranchId,
  )
  const [designStatus, setDesignStatus] = useState<DesignStatus | null>(null)

  // Load programs on mount
  useEffect(() => {
    const loadPrograms = async () => {
      try {
        const response = await apiFetch<{ data: { programs: Array<Program> } }>(
          '/api/v1/programs',
        )
        setPrograms(response.data.programs)
      } catch (error) {
        console.error('Failed to load programs:', error)
      } finally {
        setLoadingPrograms(false)
      }
    }
    loadPrograms()
  }, [])

  // Load designs when program changes
  useEffect(() => {
    if (!selectedProgramId) {
      setDesigns([])
      setSelectedDesignId(undefined)
      return
    }

    const loadDesigns = async () => {
      setLoadingDesigns(true)
      try {
        const response = await apiFetch<{ data: { designs: Array<Design> } }>(
          `/api/v1/designs?programId=${selectedProgramId}`,
        )
        setDesigns(response.data.designs)

        // Auto-select if only one design
        if (response.data.designs.length === 1) {
          setSelectedDesignId(response.data.designs[0].id)
        }
      } catch (error) {
        console.error('Failed to load designs:', error)
        setDesigns([])
      } finally {
        setLoadingDesigns(false)
      }
    }
    loadDesigns()
  }, [selectedProgramId])

  // Load branches and design status when design changes
  useEffect(() => {
    if (!selectedDesignId) {
      setBranches([])
      setDesignStatus(null)
      setSelectedBranchId(undefined)
      return
    }

    const loadBranchesAndStatus = async () => {
      setLoadingBranches(true)
      try {
        const [branchesRes, statusRes] = await Promise.all([
          apiFetch<{ data: { branches: Array<Branch> } }>(
            `/api/v1/designs/${selectedDesignId}/branches`,
          ),
          apiFetch<{ data: DesignStatus }>(
            `/api/v1/designs/${selectedDesignId}/status`,
          ),
        ])
        setBranches(branchesRes.data.branches)
        setDesignStatus(statusRes.data)

        // If post-release and no branch selected, auto-select first unlocked branch
        if (statusRes.data.protection.isMainBranchProtected) {
          const unlockedBranches = branchesRes.data.branches.filter(
            (b) => !b.isLocked && b.branchType !== 'main',
          )
          if (unlockedBranches.length === 1) {
            setSelectedBranchId(unlockedBranches[0].id)
          }
        } else {
          // Pre-release: auto-select main branch
          const mainBranch = branchesRes.data.branches.find(
            (b) => b.branchType === 'main',
          )
          if (mainBranch) {
            setSelectedBranchId(mainBranch.id)
          }
        }
      } catch (error) {
        console.error('Failed to load branches:', error)
        setBranches([])
        setDesignStatus(null)
      } finally {
        setLoadingBranches(false)
      }
    }
    loadBranchesAndStatus()
  }, [selectedDesignId])

  // Update context when selection changes
  useEffect(() => {
    // For items that don't require design (like Issues), context is always valid
    if (!requiresDesign) {
      onChange({
        programId: selectedProgramId,
        itemType,
      })
      return
    }

    if (!selectedProgramId || !selectedDesignId || !designStatus) {
      onChange(null)
      return
    }

    const phase = designStatus.protection.phase

    // For post-release, require branch selection
    if (phase === 'post-release' && !selectedBranchId) {
      onChange(null)
      return
    }

    onChange({
      programId: selectedProgramId,
      designId: selectedDesignId,
      branchId: selectedBranchId,
      designPhase: phase,
      itemType,
    })
  }, [
    selectedProgramId,
    selectedDesignId,
    selectedBranchId,
    designStatus,
    onChange,
    requiresDesign,
    itemType,
  ])

  const isPostRelease = designStatus?.protection.phase === 'post-release'

  // Filter available branches for post-release (exclude main, locked)
  const availableBranches = isPostRelease
    ? branches.filter((b) => !b.isLocked && b.branchType !== 'main')
    : branches.filter((b) => b.branchType === 'main')

  return (
    <div className="space-y-4 px-2">
      <div className="text-center mb-4">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
          {requiresDesign
            ? `Where do you want to import ${config.pluralLabel.toLowerCase()}?`
            : `Select a program for the ${config.pluralLabel.toLowerCase()} (optional)`}
        </h3>
        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">
          {requiresDesign
            ? `Select the program and design to import ${config.pluralLabel.toLowerCase()} into`
            : `You can optionally associate imported ${config.pluralLabel.toLowerCase()} with a program`}
        </p>
      </div>

      {/* Program Selection */}
      <FormField
        label="Program"
        required={requiresDesign}
        helpText={
          requiresDesign
            ? 'Select the program containing the design'
            : 'Optional: Associate imported items with a program'
        }
      >
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5 text-slate-400" />
          <Select
            value={selectedProgramId}
            onValueChange={setSelectedProgramId}
            disabled={loadingPrograms}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Select a program..." />
            </SelectTrigger>
            <SelectContent>
              {programs.map((program) => (
                <SelectItem key={program.id} value={program.id}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs text-slate-500">
                      {program.code}
                    </span>
                    <span>{program.name}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </FormField>

      {/* Design Selection - only shown for items that require design */}
      {requiresDesign && (
        <FormField
          label="Design"
          required
          helpText={`Select the design to import ${config.pluralLabel.toLowerCase()} into`}
        >
          <div className="flex items-center gap-2">
            <FolderKanban className="h-5 w-5 text-slate-400" />
            <Select
              value={selectedDesignId}
              onValueChange={setSelectedDesignId}
              disabled={!selectedProgramId || loadingDesigns}
            >
              <SelectTrigger className="flex-1">
                <SelectValue
                  placeholder={
                    !selectedProgramId
                      ? 'Select a program first'
                      : loadingDesigns
                        ? 'Loading designs...'
                        : 'Select a design...'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {designs.map((design) => (
                  <SelectItem key={design.id} value={design.id}>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-slate-500">
                        {design.code}
                      </span>
                      <span>{design.name}</span>
                      <Badge variant="outline" className="text-xs ml-2">
                        {design.designType}
                      </Badge>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </FormField>
      )}

      {/* Branch Selection (only for post-release designs that require design) */}
      {requiresDesign && selectedDesignId && designStatus && (
        <FormField
          label="Branch"
          required={isPostRelease}
          helpText={
            isPostRelease
              ? 'This design has released items. Select a branch to import new parts.'
              : 'Parts will be imported to the main branch.'
          }
        >
          <div className="flex items-center gap-2">
            <GitBranch className="h-5 w-5 text-slate-400" />
            <Select
              value={selectedBranchId}
              onValueChange={setSelectedBranchId}
              disabled={loadingBranches || !isPostRelease}
            >
              <SelectTrigger className="flex-1">
                <SelectValue
                  placeholder={
                    loadingBranches
                      ? 'Loading branches...'
                      : isPostRelease
                        ? 'Select a branch...'
                        : 'main'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {availableBranches.map((branch) => (
                  <SelectItem key={branch.id} value={branch.id}>
                    <div className="flex items-center gap-2">
                      {branch.branchType === 'eco' && (
                        <Badge variant="default" className="text-xs">
                          ECO
                        </Badge>
                      )}
                      {branch.branchType === 'workspace' && (
                        <Badge variant="secondary" className="text-xs">
                          WS
                        </Badge>
                      )}
                      <span>{branch.name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </FormField>
      )}

      {/* Status Info - only shown for items that require design */}
      {requiresDesign && designStatus && (
        <div
          className={`p-3 rounded-lg text-sm ${
            isPostRelease
              ? 'bg-amber-50 border border-amber-200 dark:bg-amber-900/20 dark:border-amber-800'
              : 'bg-green-50 border border-green-200 dark:bg-green-900/20 dark:border-green-800'
          }`}
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              className={`h-4 w-4 mt-0.5 shrink-0 ${
                isPostRelease ? 'text-amber-600' : 'text-green-600'
              }`}
            />
            <div>
              <p
                className={`font-medium ${isPostRelease ? 'text-amber-800 dark:text-amber-200' : 'text-green-800 dark:text-green-200'}`}
              >
                {isPostRelease ? 'Post-Release Design' : 'Pre-Release Design'}
              </p>
              <p
                className={`text-xs ${isPostRelease ? 'text-amber-700 dark:text-amber-300' : 'text-green-700 dark:text-green-300'}`}
              >
                {isPostRelease
                  ? 'New parts must be imported through an ECO or workspace branch.'
                  : 'Parts can be imported directly to this design.'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
