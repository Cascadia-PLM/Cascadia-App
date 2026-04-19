import { useCallback, useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { ClipboardCheck, Clock, PlayCircle } from 'lucide-react'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui'

interface WorkInstructionForPart {
  attachmentId: string
  inheritToMBOM: boolean
  attachedAt: string
  id: string
  itemNumber: string
  name: string
  revision: string
  state: string
  description?: string
  estimatedTime?: number
  difficulty?: string
}

interface WorkInstructionsForPartPanelProps {
  partId: string
  onError?: (error: Error) => void
}

const stateColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Draft: 'secondary',
  InReview: 'warning',
  Approved: 'default',
  Released: 'success',
  Obsolete: 'destructive',
}

const difficultyColors: Record<
  string,
  'default' | 'secondary' | 'success' | 'warning' | 'destructive'
> = {
  Easy: 'success',
  Medium: 'warning',
  Hard: 'destructive',
}

const formatTime = (minutes?: number) => {
  if (!minutes) return null
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const mins = minutes % 60
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

export function WorkInstructionsForPartPanel({
  partId,
  onError,
}: WorkInstructionsForPartPanelProps) {
  const [workInstructions, setWorkInstructions] = useState<
    Array<WorkInstructionForPart>
  >([])
  const [loading, setLoading] = useState(true)

  const loadWorkInstructions = useCallback(async () => {
    try {
      const response = await fetch(`/api/parts/${partId}/work-instructions`)
      if (!response.ok) {
        throw new Error('Failed to load work instructions')
      }
      const data = await response.json()
      setWorkInstructions(data.data?.workInstructions ?? [])
    } catch (error) {
      onError?.(error as Error)
    } finally {
      setLoading(false)
    }
  }, [partId, onError])

  useEffect(() => {
    loadWorkInstructions()
  }, [loadWorkInstructions])

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ClipboardCheck className="h-5 w-5 text-sky-600" />
          <CardTitle>Work Instructions</CardTitle>
        </div>
        <CardDescription>
          Work instructions associated with this part
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-slate-500 text-center py-8">
            Loading work instructions...
          </p>
        ) : workInstructions.length === 0 ? (
          <div className="text-center py-8">
            <ClipboardCheck className="h-12 w-12 mx-auto mb-3 text-slate-300 dark:text-slate-600" />
            <p className="text-slate-500 dark:text-slate-400">
              No work instructions attached to this part.
            </p>
            <p className="text-sm text-slate-400 dark:text-slate-500 mt-1">
              Work instructions can be attached from the Work Instructions
              module.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {workInstructions.map((wi) => (
              <div
                key={wi.attachmentId}
                className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-lg border dark:border-slate-700"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link
                      to="/work-instructions/$id"
                      params={{ id: wi.id }}
                      className="font-medium text-sky-600 hover:text-sky-800 hover:underline dark:text-sky-400 dark:hover:text-sky-300"
                    >
                      {wi.itemNumber}
                    </Link>
                    <Badge variant="secondary" className="text-xs">
                      Rev {wi.revision}
                    </Badge>
                    <Badge variant={stateColors[wi.state] || 'default'}>
                      {wi.state === 'InReview' ? 'In Review' : wi.state}
                    </Badge>
                    {wi.difficulty && (
                      <Badge
                        variant={difficultyColors[wi.difficulty] || 'default'}
                      >
                        {wi.difficulty}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-slate-700 dark:text-slate-300 mt-1">
                    {wi.name || 'Untitled Work Instruction'}
                  </p>
                  {(wi.estimatedTime || wi.description) && (
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-500 dark:text-slate-400">
                      {wi.estimatedTime && (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatTime(wi.estimatedTime)}
                        </span>
                      )}
                      {wi.description && (
                        <span className="truncate max-w-md">
                          {wi.description}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 ml-4">
                  <Link
                    to="/work-instructions/$id/present"
                    params={{ id: wi.id }}
                  >
                    <Button variant="outline" size="sm">
                      <PlayCircle className="h-4 w-4 mr-2" />
                      Present
                    </Button>
                  </Link>
                  <Link to="/work-instructions/$id" params={{ id: wi.id }}>
                    <Button variant="ghost" size="sm">
                      View
                    </Button>
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
