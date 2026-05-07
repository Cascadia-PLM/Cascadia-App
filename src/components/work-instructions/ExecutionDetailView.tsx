import type {
  StepContentBlock,
  WorkInstructionExecution,
  WorkInstructionStep,
} from '@/lib/items/types/work-instruction'

import {
  Badge,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui'
import { cn } from '@/lib/utils'

interface ExecutionDetailViewProps {
  execution: WorkInstructionExecution
  steps: Array<WorkInstructionStep>
}

function CapturedFieldValue({
  block,
  value,
}: {
  block: StepContentBlock
  value: unknown
}) {
  switch (block.fieldType) {
    case 'passFail':
      return (
        <span
          className={cn(
            'px-3 py-1 rounded-md text-sm font-semibold',
            value === 'pass'
              ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300'
              : value === 'fail'
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300'
                : 'bg-slate-100 text-slate-500',
          )}
        >
          {value === 'pass' ? 'Pass' : value === 'fail' ? 'Fail' : 'N/A'}
        </span>
      )
    case 'checkbox':
      return (
        <span
          className={cn(
            'text-sm font-medium',
            value ? 'text-green-600' : 'text-slate-400',
          )}
        >
          {value ? 'Checked' : 'Unchecked'}
        </span>
      )
    case 'numeric':
      return (
        <span className="text-lg font-semibold tabular-nums">
          {value != null ? String(value) : '—'}
        </span>
      )
    default:
      return (
        <span className="text-lg">{value != null ? String(value) : '—'}</span>
      )
  }
}

export function ExecutionDetailView({
  execution,
  steps,
}: ExecutionDetailViewProps) {
  const sortedSteps = [...steps].sort((a, b) => a.orderIndex - b.orderIndex)
  const stepData = execution.stepData

  return (
    <div className="space-y-6">
      {/* Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div>
          <span className="text-xs text-slate-500 block">Status</span>
          <Badge
            variant="secondary"
            className={cn(
              'font-medium mt-1',
              execution.status === 'Complete' || execution.status === 'Approved'
                ? 'bg-green-100 text-green-700'
                : execution.status === 'Incomplete' ||
                    execution.status === 'Rejected'
                  ? 'bg-red-100 text-red-700'
                  : execution.status === 'Pending Approval'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-yellow-100 text-yellow-700',
            )}
          >
            {execution.status}
          </Badge>
        </div>
        <div>
          <span className="text-xs text-slate-500 block">Started</span>
          <span className="text-sm font-medium">
            {new Date(execution.startedAt).toLocaleString()}
          </span>
        </div>
        <div>
          <span className="text-xs text-slate-500 block">Duration</span>
          <span className="text-sm font-medium tabular-nums">
            {execution.duration
              ? execution.duration < 60
                ? `${execution.duration}s`
                : `${Math.floor(execution.duration / 60)}m ${execution.duration % 60}s`
              : '—'}
          </span>
        </div>
        <div>
          <span className="text-xs text-slate-500 block">Data Fields</span>
          <span className="text-sm font-medium">
            {Object.keys(stepData).length} captured
          </span>
        </div>
      </div>

      {execution.notes && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Notes</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-slate-700 dark:text-slate-300 whitespace-pre-wrap">
              {execution.notes}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Step-by-step data */}
      {sortedSteps.map((step, index) => {
        const dataFields = step.content.blocks.filter(
          (b) => b.type === 'dataField',
        )
        const capturedData = dataFields
          .map((block) => ({
            block,
            entry: stepData[block.id],
          }))
          .filter((d) => d.entry)

        if (capturedData.length === 0) return null

        return (
          <Card key={step.id}>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <span className="flex items-center justify-center h-7 w-7 rounded-full bg-slate-100 text-slate-600 text-sm font-medium dark:bg-slate-700 dark:text-slate-300">
                  {index + 1}
                </span>
                {step.title || `Step ${index + 1}`}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {capturedData.map(({ block, entry }) => (
                  <div
                    key={block.id}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <span className="text-sm text-slate-600 dark:text-slate-400">
                      {block.fieldLabel || 'Field'}
                    </span>
                    <CapturedFieldValue block={block} value={entry.value} />
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )
      })}

      {Object.keys(stepData).length === 0 && (
        <p className="text-slate-500 text-center py-8">
          No data was captured during this execution.
        </p>
      )}
    </div>
  )
}
