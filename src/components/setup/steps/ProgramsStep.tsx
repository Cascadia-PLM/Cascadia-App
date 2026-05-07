// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Cascadia PLM contributors

import { useEffect, useState } from 'react'
import {
  CheckCircle,
  Database,
  FileText,
  Loader2,
  Package,
  Plus,
} from 'lucide-react'
import { strings } from '../strings'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui'

interface CreatedProgram {
  id: string
  name: string
  code: string
}

interface CreatedDesign {
  id: string
  name: string
  code: string
}

interface ProgramsStepProps {
  onCompleted: () => void
}

export function ProgramsStep({ onCompleted }: ProgramsStepProps) {
  const [programs, setPrograms] = useState<Array<CreatedProgram>>([])
  const [designs, setDesigns] = useState<Array<CreatedDesign>>([])

  // Program form
  const [programForm, setProgramForm] = useState({ name: '', code: '' })
  const [savingProgram, setSavingProgram] = useState(false)
  const [programError, setProgramError] = useState('')

  // Design form
  const [designForm, setDesignForm] = useState({
    name: '',
    code: '',
    programId: '',
    designType: 'Engineering' as 'Engineering' | 'Library' | 'Family',
  })
  const [savingDesign, setSavingDesign] = useState(false)
  const [designError, setDesignError] = useState('')

  // Part form
  const [partForm, setPartForm] = useState({
    name: '',
    partType: 'Manufacture' as
      | 'Manufacture'
      | 'Purchase'
      | 'Phantom'
      | 'Software',
    designId: '',
  })
  const [savingPart, setSavingPart] = useState(false)
  const [partError, setPartError] = useState('')
  const [createdParts, setCreatedParts] = useState<
    Array<{ id: string; name: string }>
  >([])

  // Catalog seed
  const [seedingCatalog, setSeedingCatalog] = useState(false)
  const [catalogResult, setCatalogResult] = useState<{
    inserted: number
    skipped: number
  } | null>(null)
  const [catalogError, setCatalogError] = useState('')

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/v1/programs').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/v1/designs').then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([programJson, designJson]) => {
        if (cancelled) return
        const programList = (programJson?.data?.programs ??
          []) as Array<CreatedProgram>
        const designList = (designJson?.data?.designs ??
          []) as Array<CreatedDesign>
        setPrograms(programList)
        setDesigns(designList)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const handleCreateProgram = async () => {
    if (!programForm.name.trim() || !programForm.code.trim()) {
      setProgramError('Name and code are required')
      return
    }
    setSavingProgram(true)
    setProgramError('')
    try {
      const response = await fetch('/api/v1/programs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: programForm.name.trim(),
          code: programForm.code.trim().toUpperCase(),
        }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to create program')
      }
      const json = await response.json()
      const created = (json.data?.program ?? json.data) as CreatedProgram
      setPrograms((prev) => [...prev, created])
      setProgramForm({ name: '', code: '' })
      // Pre-select the new program for the design form.
      setDesignForm((d) => ({ ...d, programId: created.id }))
    } catch (err) {
      setProgramError((err as Error).message)
    } finally {
      setSavingProgram(false)
    }
  }

  const handleCreateDesign = async () => {
    if (!designForm.name.trim() || !designForm.code.trim()) {
      setDesignError('Name and code are required')
      return
    }
    setSavingDesign(true)
    setDesignError('')
    try {
      const response = await fetch('/api/v1/designs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: designForm.name.trim(),
          code: designForm.code.trim().toUpperCase(),
          programId: designForm.programId || undefined,
          designType: designForm.designType,
        }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to create design')
      }
      const json = await response.json()
      const created = (json.data?.design ?? json.data) as CreatedDesign
      setDesigns((prev) => [...prev, created])
      setDesignForm({ ...designForm, name: '', code: '' })
      setPartForm((p) => ({ ...p, designId: created.id }))
    } catch (err) {
      setDesignError((err as Error).message)
    } finally {
      setSavingDesign(false)
    }
  }

  const handleCreatePart = async () => {
    if (!partForm.name.trim()) {
      setPartError('Part name is required')
      return
    }
    if (!partForm.designId) {
      setPartError('Pick a design')
      return
    }
    setSavingPart(true)
    setPartError('')
    try {
      const response = await fetch('/api/v1/items', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          itemType: 'Part',
          name: partForm.name.trim(),
          partType: partForm.partType,
          designId: partForm.designId,
        }),
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to create part')
      }
      const json = await response.json()
      const created = (json.data?.item ?? json.data) as {
        id: string
        name: string
      }
      setCreatedParts((prev) => [...prev, created])
      setPartForm({ ...partForm, name: '' })
    } catch (err) {
      setPartError((err as Error).message)
    } finally {
      setSavingPart(false)
    }
  }

  const handleSeedCatalog = async () => {
    setSeedingCatalog(true)
    setCatalogError('')
    try {
      const response = await fetch('/api/v1/setup/seed-catalog', {
        method: 'POST',
      })
      if (!response.ok) {
        const json = await response.json().catch(() => ({}))
        throw new Error(json.error?.message ?? 'Failed to load sample catalog')
      }
      const json = await response.json()
      setCatalogResult(
        (json.data ?? { inserted: 0, skipped: 0 }) as {
          inserted: number
          skipped: number
        },
      )
    } catch (err) {
      setCatalogError((err as Error).message)
    } finally {
      setSeedingCatalog(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Database className="w-6 h-6 text-slate-700 dark:text-slate-300" />
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">
            {strings.steps.programs.title}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {strings.steps.programs.description}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create program</CardTitle>
            <CardDescription>e.g. ROBOTARM-V1</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="prog-name">Name</Label>
              <Input
                id="prog-name"
                value={programForm.name}
                onChange={(e) =>
                  setProgramForm({ ...programForm, name: e.target.value })
                }
                placeholder="Robot Arm V1"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="prog-code">Code</Label>
              <Input
                id="prog-code"
                value={programForm.code}
                onChange={(e) =>
                  setProgramForm({ ...programForm, code: e.target.value })
                }
                placeholder="ROBOTARM-V1"
                className="font-mono"
              />
            </div>
            {programError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {programError}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreateProgram}
              disabled={savingProgram}
              className="w-full"
            >
              {savingProgram ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Create program
            </Button>
            {programs.length > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {programs.length} program{programs.length > 1 ? 's' : ''} total
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Create design</CardTitle>
            <CardDescription>
              Container for a related set of items
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="des-name">Name</Label>
              <Input
                id="des-name"
                value={designForm.name}
                onChange={(e) =>
                  setDesignForm({ ...designForm, name: e.target.value })
                }
                placeholder="Forearm Assembly"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="des-code">Code</Label>
              <Input
                id="des-code"
                value={designForm.code}
                onChange={(e) =>
                  setDesignForm({ ...designForm, code: e.target.value })
                }
                placeholder="FOREARM"
                className="font-mono"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="des-program">Program (optional)</Label>
              <Select
                value={designForm.programId || 'none'}
                onValueChange={(v) =>
                  setDesignForm({
                    ...designForm,
                    programId: v === 'none' ? '' : v,
                  })
                }
              >
                <SelectTrigger id="des-program">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No program</SelectItem>
                  {programs.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {designError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {designError}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreateDesign}
              disabled={savingDesign}
              className="w-full"
            >
              {savingDesign ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Create design
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add a part</CardTitle>
            <CardDescription>Quick smoke test of part creation</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="part-name">Name</Label>
              <Input
                id="part-name"
                value={partForm.name}
                onChange={(e) =>
                  setPartForm({ ...partForm, name: e.target.value })
                }
                placeholder="Forearm Bracket"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="part-type">Type</Label>
              <Select
                value={partForm.partType}
                onValueChange={(v) =>
                  setPartForm({
                    ...partForm,
                    partType: v as typeof partForm.partType,
                  })
                }
              >
                <SelectTrigger id="part-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Manufacture">Manufacture</SelectItem>
                  <SelectItem value="Purchase">Purchase</SelectItem>
                  <SelectItem value="Phantom">Phantom</SelectItem>
                  <SelectItem value="Software">Software</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="part-design">Design</Label>
              <Select
                value={partForm.designId}
                onValueChange={(v) => setPartForm({ ...partForm, designId: v })}
              >
                <SelectTrigger id="part-design">
                  <SelectValue placeholder="Pick a design" />
                </SelectTrigger>
                <SelectContent>
                  {designs.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {partError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {partError}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreatePart}
              disabled={savingPart}
              className="w-full"
            >
              {savingPart ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-2" />
              )}
              Add part
            </Button>
            {createdParts.length > 0 && (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {createdParts.length} part
                {createdParts.length > 1 ? 's' : ''} created
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Package className="w-5 h-5 text-slate-600 dark:text-slate-400" />
            <CardTitle>Sample data</CardTitle>
          </div>
          <CardDescription>
            Load the bundled fastener and raw stock catalog so the design engine
            has a baseline to draw from. Safe to re-run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Button
              variant="outline"
              onClick={handleSeedCatalog}
              disabled={seedingCatalog}
            >
              {seedingCatalog ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
              ) : (
                <Package className="w-4 h-4 mr-2" />
              )}
              Load standard catalog
            </Button>
            {catalogResult && (
              <span className="flex items-center gap-1 text-sm text-green-600 dark:text-green-400">
                <CheckCircle className="w-4 h-4" />
                {catalogResult.inserted} entries added, {catalogResult.skipped}{' '}
                skipped
              </span>
            )}
            {catalogError && (
              <span className="text-sm text-red-600 dark:text-red-400">
                {catalogError}
              </span>
            )}
          </div>

          <div className="text-sm text-slate-600 dark:text-slate-400 flex items-center gap-2">
            <FileText className="w-4 h-4" />
            <span>
              For larger datasets, you can bulk-import parts from a CSV at{' '}
              <a
                href="/api/import/parts"
                className="text-blue-600 dark:text-blue-400 underline"
              >
                /api/import/parts
              </a>{' '}
              once setup is finished.
            </span>
          </div>
        </CardContent>
      </Card>

      <div>
        <Button onClick={onCompleted}>Continue to summary</Button>
      </div>
    </div>
  )
}
