import { AlertTriangle } from 'lucide-react'

interface ChangeAlertBannerProps {
  pendingCount: number
  onViewAlerts: () => void
}

export function ChangeAlertBanner({
  pendingCount,
  onViewAlerts,
}: ChangeAlertBannerProps) {
  if (pendingCount === 0) return null

  return (
    <div className="flex items-center gap-3 px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg mb-4">
      <AlertTriangle className="h-5 w-5 text-amber-600 dark:text-amber-400 shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
          {pendingCount} linked part{pendingCount !== 1 ? 's have' : ' has'}{' '}
          been modified
        </p>
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Review changes to ensure this work instruction is still accurate.
        </p>
      </div>
      <button
        className="text-sm font-medium text-amber-700 dark:text-amber-300 hover:underline shrink-0"
        onClick={onViewAlerts}
      >
        View Alerts
      </button>
    </div>
  )
}
