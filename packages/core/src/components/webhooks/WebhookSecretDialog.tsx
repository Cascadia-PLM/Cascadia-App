// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import { AlertTriangle, Check, Copy } from 'lucide-react'
import { Button } from '@/components/ui'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/Dialog'

interface WebhookSecretDialogProps {
  secret: string | null
  /** Distinguishes a freshly created subscription from a rotated one. */
  mode: 'created' | 'rotated'
  onClose: () => void
}

/**
 * The one and only time a signing secret is visible.
 *
 * Deliberately the same moment as the API-key experience, because it is the same
 * promise: copy it now, it is gone. The difference worth stating in the copy is
 * *why* — an API key is stored as a one-way hash, while a webhook secret is
 * stored encrypted and simply never read back out to a human. Either way a lost
 * secret is rotated, not recovered.
 */
export function WebhookSecretDialog({
  secret,
  mode,
  onClose,
}: WebhookSecretDialogProps) {
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')

  const handleClose = () => {
    setCopy('idle')
    onClose()
  }

  return (
    <Dialog
      open={secret !== null}
      onOpenChange={(open) => {
        if (!open) handleClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode === 'created'
              ? 'Subscription created'
              : 'Signing secret rotated'}
          </DialogTitle>
          <DialogDescription>
            Copy this secret now. It is stored encrypted and is never shown
            again — a lost secret is rotated, not recovered.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded bg-slate-100 p-3 text-sm break-all dark:bg-slate-800">
              {secret}
            </code>
            <Button
              variant="outline"
              size="icon"
              onClick={() => {
                if (!secret) return
                // The clipboard can refuse — an insecure context, a denied
                // permission — and a "copied" tick when it did would send an
                // operator away without the only copy of the secret.
                void navigator.clipboard.writeText(secret).then(
                  () => setCopy('copied'),
                  () => setCopy('failed'),
                )
              }}
              title="Copy to clipboard"
            >
              {copy === 'copied' ? (
                <Check className="h-4 w-4 text-green-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>

          {copy === 'failed' && (
            <p className="text-sm text-destructive">
              Copying to the clipboard failed. Select the secret above and copy
              it by hand before closing this.
            </p>
          )}

          <div className="flex gap-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              {mode === 'rotated' ? (
                <>
                  The previous secret stopped working immediately. Deliveries
                  signed with it will fail verification until the receiver is
                  updated.
                </>
              ) : (
                <>
                  Give this to the receiver so it can verify deliveries. Every
                  request carries an <code>X-Cascadia-Signature</code> header of
                  the form <code>t=&lt;timestamp&gt;,v1=&lt;hmac&gt;</code>, an
                  HMAC-SHA256 over{' '}
                  <code>v1.&lt;timestamp&gt;.&lt;body&gt;</code>
                  using the exact bytes received.
                </>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={handleClose}>
            {copy === 'copied' ? 'Done' : 'I have copied it'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
