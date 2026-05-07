import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import {
  AlertCircle,
  Box,
  Check,
  Cpu,
  Globe,
  Loader2,
  RotateCcw,
} from 'lucide-react'
import type { Part } from '@/lib/items/types/part'
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Progress,
} from '@/components/ui'
import { apiFetch } from '@/lib/api/client'

interface GenerateCadDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  part: Part
}

type Phase =
  | 'assessing'
  | 'assessed'
  | 'generating'
  | 'converting'
  | 'complete'
  | 'error'

interface Assessment {
  canParametric: boolean
  template?: string
  parameters?: Record<string, number>
  units?: 'mm' | 'in'
  reasoning: string
}

interface JobStatus {
  id: string
  status: string
  progress: number
  progressMessage: string | null
  result: Record<string, unknown> | null
  error: string | null
}

export function GenerateCadDialog({
  open,
  onOpenChange,
  part,
}: GenerateCadDialogProps) {
  const router = useRouter()
  const [phase, setPhase] = useState<Phase>('assessing')
  const [assessment, setAssessment] = useState<Assessment | null>(null)
  const [jobProgress, setJobProgress] = useState(0)
  const [jobMessage, setJobMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const cleanup = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setPhase('assessing')
      setAssessment(null)
      setJobProgress(0)
      setJobMessage('')
      setErrorMessage('')
      runAssessment()
    } else {
      cleanup()
    }
    return cleanup
  }, [open])

  async function runAssessment() {
    try {
      const response = await apiFetch<{ data: Assessment }>(
        `/api/parts/${part.id}/generate-cad/assess`,
        { method: 'POST' },
      )
      setAssessment(response.data)
      setPhase('assessed')
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Assessment failed')
      setPhase('error')
    }
  }

  function pollJob(
    jobId: string,
    onComplete: (result: Record<string, unknown>) => void,
  ) {
    cleanup()
    pollRef.current = setInterval(async () => {
      try {
        const response = await apiFetch<{ data: JobStatus }>(
          `/api/jobs/${jobId}`,
        )
        const job = response.data
        setJobProgress(job.progress)
        setJobMessage(job.progressMessage)

        if (job.status === 'completed' && job.result) {
          cleanup()
          onComplete(job.result)
        } else if (job.status === 'failed') {
          cleanup()
          setErrorMessage(job.error ?? 'Job failed')
          setPhase('error')
        }
      } catch {
        // Ignore polling errors — retry on next tick
      }
    }, 2000)
  }

  async function startGeneration(method: 'parametric' | 'zoo') {
    setPhase('generating')
    setJobProgress(0)
    setJobMessage('Starting generation...')

    try {
      const body: Record<string, unknown> = { method }
      if (method === 'parametric' && assessment) {
        body.template = assessment.template
        body.parameters = assessment.parameters
        body.units = assessment.units
      }

      const response = await apiFetch<{ data: { jobId: string } }>(
        `/api/parts/${part.id}/generate-cad`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )

      pollJob(response.data.jobId, (result) => {
        startConversion(result.vaultFileId as string)
      })
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Generation failed')
      setPhase('error')
    }
  }

  async function startConversion(fileId: string) {
    setPhase('converting')
    setJobProgress(0)
    setJobMessage('Starting conversion...')

    try {
      const response = await apiFetch<{ data: { jobId: string } }>(
        `/api/parts/${part.id}/generate-cad/convert`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ vaultFileId: fileId }),
        },
      )

      pollJob(response.data.jobId, () => {
        setPhase('complete')
      })
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Conversion failed')
      setPhase('error')
    }
  }

  function handleDone() {
    onOpenChange(false)
    router.invalidate()
  }

  function handleRetry() {
    setPhase('assessing')
    setErrorMessage('')
    runAssessment()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Box className="h-5 w-5" />
            Generate CAD
          </DialogTitle>
          <DialogDescription>
            Generate a STEP file for{' '}
            <span className="font-medium">{part.name || part.itemNumber}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Assessing phase */}
          {phase === 'assessing' && (
            <div className="flex items-center gap-3 py-6 justify-center text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span>Analyzing part for CAD generation...</span>
            </div>
          )}

          {/* Assessed phase */}
          {phase === 'assessed' && assessment && (
            <div className="space-y-4">
              <div className="rounded-lg border p-4 bg-slate-50 dark:bg-slate-900">
                <p className="text-sm text-slate-700 dark:text-slate-300">
                  {assessment.reasoning}
                </p>
                {assessment.canParametric && assessment.template && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Badge variant="secondary">
                      Template: {assessment.template}
                    </Badge>
                    <Badge variant="secondary">
                      Units: {assessment.units || 'mm'}
                    </Badge>
                  </div>
                )}
                {assessment.canParametric && assessment.parameters && (
                  <div className="mt-2 text-xs text-slate-500 dark:text-slate-400 font-mono">
                    {Object.entries(assessment.parameters)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(', ')}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                {assessment.canParametric ? (
                  <>
                    <Button
                      onClick={() => startGeneration('parametric')}
                      className="w-full"
                    >
                      <Cpu className="h-4 w-4 mr-2" />
                      Generate using parametric service
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => startGeneration('zoo')}
                      className="w-full"
                    >
                      <Globe className="h-4 w-4 mr-2" />
                      Attempt via external API
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      onClick={() => startGeneration('zoo')}
                      className="w-full"
                    >
                      <Globe className="h-4 w-4 mr-2" />
                      Generate via external API
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => startGeneration('parametric')}
                      className="w-full"
                      disabled={!assessment.template}
                    >
                      <Cpu className="h-4 w-4 mr-2" />
                      Try parametric anyway
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* Generating phase */}
          {phase === 'generating' && (
            <div className="space-y-3 py-4">
              <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin text-cyan-500" />
                <span>Generating CAD model...</span>
              </div>
              <Progress value={jobProgress} className="h-2" />
              {jobMessage && (
                <p className="text-xs text-slate-500">{jobMessage}</p>
              )}
            </div>
          )}

          {/* Converting phase */}
          {phase === 'converting' && (
            <div className="space-y-3 py-4">
              <div className="flex items-center gap-3 text-slate-600 dark:text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin text-cyan-500" />
                <span>Converting STEP to viewable format...</span>
              </div>
              <Progress value={jobProgress} className="h-2" />
              {jobMessage && (
                <p className="text-xs text-slate-500">{jobMessage}</p>
              )}
            </div>
          )}

          {/* Complete phase */}
          {phase === 'complete' && (
            <div className="flex flex-col items-center gap-3 py-6">
              <div className="rounded-full bg-green-100 p-3 dark:bg-green-900/30">
                <Check className="h-6 w-6 text-green-600 dark:text-green-400" />
              </div>
              <p className="text-sm font-medium text-slate-700 dark:text-slate-300">
                CAD files generated and attached to part
              </p>
            </div>
          )}

          {/* Error phase */}
          {phase === 'error' && (
            <div className="space-y-3 py-4">
              <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950/30">
                <AlertCircle className="h-5 w-5 text-red-500 mt-0.5 shrink-0" />
                <p className="text-sm text-red-700 dark:text-red-400">
                  {errorMessage}
                </p>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          {phase === 'complete' && <Button onClick={handleDone}>Done</Button>}
          {phase === 'error' && (
            <div className="flex gap-2 w-full justify-end">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button onClick={handleRetry}>
                <RotateCcw className="h-4 w-4 mr-2" />
                Retry
              </Button>
            </div>
          )}
          {(phase === 'assessing' ||
            phase === 'generating' ||
            phase === 'converting') && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
