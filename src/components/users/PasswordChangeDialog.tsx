import { useState } from 'react'
import type { UserWithRoles } from '@/lib/auth/types'
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

interface PasswordChangeDialogProps {
  user: UserWithRoles | null
  open: boolean
  onClose: () => void
  onSave: (userId: string, password: string) => Promise<void>
}

export function PasswordChangeDialog({
  user,
  open,
  onClose,
  onSave,
}: PasswordChangeDialogProps) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    if (!user) return

    // Validation
    if (password.length < 8) {
      setError('Password must be at least 8 characters')
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
    } catch {
      setError('Failed to change password')
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
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Change Password</DialogTitle>
          <DialogDescription>
            Set a new password for {user.name || user.email}
          </DialogDescription>
        </DialogHeader>

        <div className="py-6 space-y-4">
          <FormField
            label="New Password"
            required
            error={error && error.includes('8 characters') ? error : undefined}
            helpText="Minimum 8 characters"
          >
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              error={!!error && error.includes('8 characters')}
            />
          </FormField>

          <FormField
            label="Confirm Password"
            required
            error={error && error.includes('match') ? error : undefined}
            helpText="Re-enter the new password"
          >
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              error={!!error && error.includes('match')}
            />
          </FormField>

          {error &&
            !error.includes('8 characters') &&
            !error.includes('match') && (
              <div className="text-sm text-red-600">{error}</div>
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
            {isSubmitting ? 'Saving...' : 'Change Password'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
