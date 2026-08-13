// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { useState } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FormField,
  Input,
} from '@/components/ui'

interface PasswordResetUser {
  id: string
  email: string
  name: string | null
}

interface PasswordResetDialogProps {
  user: PasswordResetUser | null
  open: boolean
  onClose: () => void
  onSave: (userId: string, password: string) => Promise<void>
}

export function PasswordResetDialog({
  user,
  open,
  onClose,
  onSave,
}: PasswordResetDialogProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!user) return

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      return
    }

    if (password.length > 128) {
      setError('Password must not exceed 128 characters')
      return
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      await onSave(user.id, password)
      setPassword('')
      setConfirmPassword('')
      onClose()
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : 'Failed to reset password',
      )
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleClose = () => {
    setPassword('')
    setConfirmPassword('')
    setError(null)
    onClose()
  }

  if (!user) return null

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && handleClose()}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Reset Password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.name || user.email}. This will sign
            them out of all active sessions.
          </DialogDescription>
        </DialogHeader>

        <div className="py-6 space-y-4">
          <FormField
            label="New Password"
            required
            helpText="8 to 128 characters"
          >
            <Input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
            />
          </FormField>

          <FormField label="Confirm Password" required>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
              minLength={8}
              maxLength={128}
            />
          </FormField>

          {error && (
            <div className="text-sm text-red-600 dark:text-red-400">
              {error}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleClose}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSubmitting}>
            {isSubmitting ? 'Resetting...' : 'Reset Password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
