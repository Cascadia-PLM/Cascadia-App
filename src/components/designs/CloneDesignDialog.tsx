import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { CheckCircle2, Copy, Loader2, XCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Textarea } from '@/components/ui/Textarea'
import { Label } from '@/components/ui/Label'
import { Checkbox } from '@/components/ui/Checkbox'
import { Progress } from '@/components/ui/Progress'
import { apiFetch } from '@/lib/api/client'

interface CloneDesignDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sourceDesignId: string
  sourceDesignCode: string
  sourceDesignName: string
}

type CloneStatus = 'idle' | 'submitting' | 'cloning' | 'completed' | 'failed'

interface JobStatus {
  id: string
  status:
    | 'pending'
    | 'queued'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
  progress: number
  progressMessage: string | null
  result: {
    designId: string
    designCode: string
    itemsCloned: number
    relationshipsCloned: number
    derivedFromCreated: number
    filesReferenced: number
  } | null
  error: string | null
}

export function CloneDesignDialog({
  open,
  onOpenChange,
  sourceDesignId,
  sourceDesignCode,
  sourceDesignName,
}: CloneDesignDialogProps) {
  const navigate = useNavigate()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<CloneStatus>('idle')
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState(0)
  const [progressMessage, setProgressMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<JobStatus['result'] | null>(null)
  const [suffixItemNumbers, setSuffixItemNumbers] = useState(false)

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setCode(`${sourceDesignCode}-COPY`)
      setName(`${sourceDesignName} (Copy)`)
      setDescription('')
      setStatus('idle')
      setJobId(null)
      setProgress(0)
      setProgressMessage('')
      setError(null)
      setResult(null)
      setSuffixItemNumbers(false)
    }
  }, [open, sourceDesignCode, sourceDesignName])

  // Poll job status when cloning
  useEffect(() => {
    if (!jobId || status !== 'cloning') return

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/v1/jobs/${jobId}`)
        if (!response.ok) {
          throw new Error('Failed to get job status')
        }

        const { data } = (await response.json()) as { data: JobStatus }

        setProgress(data.progress || 0)
        setProgressMessage(data.progressMessage || '')

        if (data.status === 'completed') {
          setStatus('completed')
          setResult(data.result)
          clearInterval(pollInterval)
        } else if (data.status === 'failed') {
          setStatus('failed')
          setError(data.error || 'Clone failed')
          clearInterval(pollInterval)
        }
      } catch {
        // Silently fail - polling will retry on next interval
      }
    }, 1000)

    return () => clearInterval(pollInterval)
  }, [jobId, status])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setStatus('submitting')
    setError(null)

    try {
      const response = await apiFetch(`/api/v1/designs/${sourceDesignId}/clone`, {
        method: 'POST',
        body: JSON.stringify({
          code: code.toUpperCase(),
          name,
          description: description || undefined,
          suffixItemNumbers: suffixItemNumbers || undefined,
        }),
      })

      const { data } = response as { data: { jobId: string } }
      setJobId(data.jobId)
      setStatus('cloning')
    } catch (err) {
      setStatus('failed')
      setError((err as Error).message || 'Failed to start clone')
    }
  }

  const handleNavigateToNewDesign = () => {
    if (result?.designId) {
      onOpenChange(false)
      navigate({ to: '/designs/$id', params: { id: result.designId } })
    }
  }

  const handleClose = () => {
    if (status === 'cloning') {
      // Don't close while cloning is in progress
      return
    }
    onOpenChange(false)
  }

  const isFormDisabled = status !== 'idle'

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Copy className="h-5 w-5" />
            Clone Design
          </DialogTitle>
          <DialogDescription>
            Create a copy of{' '}
            <span className="font-medium">{sourceDesignCode}</span> with all its
            items and relationships.
          </DialogDescription>
        </DialogHeader>

        {status === 'idle' || status === 'submitting' ? (
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="code">Design Code</Label>
                <Input
                  id="code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  placeholder="e.g., HULL-3"
                  required
                  disabled={isFormDisabled}
                  pattern="[A-Z0-9\-]+"
                  title="Uppercase letters, numbers, and hyphens only"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Must be unique. Uppercase letters, numbers, and hyphens only.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g., Hull Assembly 3"
                  required
                  disabled={isFormDisabled}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (optional)</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Description of the cloned design..."
                  rows={3}
                  disabled={isFormDisabled}
                />
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="suffixItemNumbers"
                  checked={suffixItemNumbers}
                  onCheckedChange={(checked) =>
                    setSuffixItemNumbers(checked as boolean)
                  }
                  disabled={isFormDisabled}
                />
                <Label
                  htmlFor="suffixItemNumbers"
                  className="text-sm font-normal cursor-pointer"
                >
                  Suffix item numbers with design code
                </Label>
              </div>
              {suffixItemNumbers && code && (
                <p className="text-xs text-slate-500 dark:text-slate-400 ml-6">
                  e.g., PN-000001-{code}
                </p>
              )}

              {error && (
                <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-950 p-3 rounded-lg">
                  <XCircle className="h-4 w-4" />
                  {error}
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={handleClose}
                disabled={status === 'submitting'}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={status === 'submitting'}>
                {status === 'submitting' ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Starting...
                  </>
                ) : (
                  'Clone Design'
                )}
              </Button>
            </DialogFooter>
          </form>
        ) : status === 'cloning' ? (
          <div className="py-8 space-y-4">
            <div className="flex items-center justify-center">
              <Loader2 className="h-8 w-8 animate-spin text-cyan-600" />
            </div>
            <div className="text-center">
              <p className="font-medium text-slate-900 dark:text-slate-100">
                Cloning design...
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                {progressMessage || 'Please wait'}
              </p>
            </div>
            <Progress value={progress} className="h-2" />
            <p className="text-center text-sm text-slate-500 dark:text-slate-400">
              {progress}%
            </p>
          </div>
        ) : status === 'completed' && result ? (
          <div className="py-8 space-y-4">
            <div className="flex items-center justify-center">
              <CheckCircle2 className="h-12 w-12 text-green-600" />
            </div>
            <div className="text-center">
              <p className="font-medium text-lg text-slate-900 dark:text-slate-100">
                Clone Complete
              </p>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
                Created{' '}
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.designCode}
                </span>
              </p>
            </div>
            <div className="bg-slate-50 dark:bg-slate-900 rounded-lg p-4 text-sm space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Items cloned:
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.itemsCloned}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Relationships cloned:
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.relationshipsCloned}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  Traceability links created:
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.derivedFromCreated}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-slate-400">
                  File references:
                </span>
                <span className="font-medium text-slate-900 dark:text-slate-100">
                  {result.filesReferenced}
                </span>
              </div>
            </div>
            <DialogFooter className="sm:justify-center">
              <Button onClick={handleNavigateToNewDesign}>
                Go to New Design
              </Button>
            </DialogFooter>
          </div>
        ) : status === 'failed' ? (
          <div className="py-8 space-y-4">
            <div className="flex items-center justify-center">
              <XCircle className="h-12 w-12 text-red-600" />
            </div>
            <div className="text-center">
              <p className="font-medium text-lg text-slate-900 dark:text-slate-100">
                Clone Failed
              </p>
              <p className="text-sm text-red-600 dark:text-red-400 mt-1">
                {error}
              </p>
            </div>
            <DialogFooter className="sm:justify-center">
              <Button variant="outline" onClick={() => setStatus('idle')}>
                Try Again
              </Button>
              <Button onClick={handleClose}>Close</Button>
            </DialogFooter>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
