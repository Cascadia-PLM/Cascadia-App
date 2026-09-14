// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { RotateCcw, SkipForward } from 'lucide-react'
import type { EventConsumerStatus } from '@/lib/query'
import { Button } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'

export interface ConsumerErrorDialogProps {
  consumer: EventConsumerStatus | null
  onClose: () => void
  onResume: (consumer: EventConsumerStatus) => void
  onSkip: (consumer: EventConsumerStatus) => void
  busy?: boolean
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <dt className="text-xs font-medium text-slate-500 dark:text-slate-400">
        {label}
      </dt>
      <dd className="text-sm text-slate-900 dark:text-slate-100">{children}</dd>
    </div>
  )
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString()
}

/**
 * Why a consumer stopped, and the two ways out of it.
 *
 * Both actions are offered from here rather than from the menu alone because
 * the choice between them depends on what the error says: resume re-attempts
 * the same event, so it is right for a transient failure, while skip advances
 * the cursor past it and is the only way forward for a genuinely poisonous
 * event — at the cost of that event never being handled.
 */
export function ConsumerErrorDialog({
  consumer,
  onClose,
  onResume,
  onSkip,
  busy = false,
}: ConsumerErrorDialogProps) {
  return (
    <Dialog
      open={consumer !== null}
      onOpenChange={(open) => !open && onClose()}
    >
      <DialogContent className="max-w-2xl">
        {consumer && (
          <>
            <DialogHeader>
              <DialogTitle className="font-mono text-base">
                {consumer.id}
              </DialogTitle>
              <DialogDescription>
                {consumer.abandonedAt
                  ? 'Retention gave up waiting for this consumer. Its backlog is forfeit — resuming it will not bring the skipped events back.'
                  : consumer.parkedAt
                    ? 'Parked after repeated failures. It will not retry on its own until you resume it or skip the event it is stuck on.'
                    : 'Still retrying. The cursor has not moved past the event below.'}
              </DialogDescription>
            </DialogHeader>

            <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Consecutive failures">
                {consumer.failureCount}
              </Field>
              <Field label="Stuck at seq">{consumer.lastErrorSeq ?? '—'}</Field>
              <Field label="Cursor">{consumer.lastSeq}</Field>
              <Field label="Last failure">
                {formatWhen(consumer.lastErrorAt)}
              </Field>
              <Field label="Next attempt">
                {formatWhen(consumer.nextAttemptAt)}
              </Field>
              <Field label="Parked">{formatWhen(consumer.parkedAt)}</Field>
            </dl>

            <div>
              <div className="mb-1 text-xs font-medium text-slate-500 dark:text-slate-400">
                Error
              </div>
              <pre className="max-h-64 overflow-auto rounded border border-slate-300 bg-slate-50 p-3 font-mono text-xs whitespace-pre-wrap text-red-700 dark:border-slate-700 dark:bg-slate-900 dark:text-red-400">
                {consumer.lastError ?? 'No error recorded.'}
              </pre>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="outline"
                disabled={busy || consumer.lastErrorSeq === null}
                onClick={() => onSkip(consumer)}
              >
                <SkipForward className="mr-2 h-4 w-4" />
                Skip seq {consumer.lastErrorSeq ?? ''}
              </Button>
              <Button disabled={busy} onClick={() => onResume(consumer)}>
                <RotateCcw className="mr-2 h-4 w-4" />
                Resume
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
