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

interface ApiKeySecretDialogProps {
  secret: string | null
  /** Distinguishes a freshly minted key from a rotated one in the copy. */
  mode: 'created' | 'rotated'
  onClose: () => void
}

/**
 * The one and only time a key's secret is visible.
 *
 * Shared by create and rotate so the "copy it now, it is gone forever"
 * moment looks and behaves identically in both — the two paths differ only in
 * what the old secret means afterwards.
 */
export function ApiKeySecretDialog({
  secret,
  mode,
  onClose,
}: ApiKeySecretDialogProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    if (!secret) return
    void navigator.clipboard.writeText(secret)
    setCopied(true)
  }

  const handleClose = () => {
    setCopied(false)
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
            {mode === 'created' ? 'API key created' : 'API key rotated'}
          </DialogTitle>
          <DialogDescription>
            Copy this key now — only a hash is stored, so it cannot be shown
            again.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 p-3 bg-slate-100 dark:bg-slate-800 rounded text-sm break-all">
              {secret}
            </code>
            <Button variant="outline" onClick={handleCopy}>
              {copied ? (
                <Check className="w-4 h-4 mr-1" />
              ) : (
                <Copy className="w-4 h-4 mr-1" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>

          {mode === 'rotated' && (
            <div className="flex items-start gap-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>
                The previous secret stopped working immediately. Update every
                client using this key before it next runs.
              </span>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={handleClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
