/**
 * ConfirmationCard - Confirmation UI for AI write operations
 *
 * Displays a card with operation details and Confirm/Cancel buttons.
 * Used in the chat UI when AI requests confirmation for write operations.
 */

import { AlertTriangle, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

export interface ConfirmationDetails {
  action: string
  itemType?: string
  itemName?: string
  designName?: string
  changeOrderNumber?: string
  additionalInfo?: Array<string>
}

interface ConfirmationCardProps {
  /** The confirmation message to display */
  message: string
  /** Structured details about the operation */
  details?: ConfirmationDetails
  /** Called when user clicks Confirm */
  onConfirm: () => void
  /** Called when user clicks Cancel */
  onCancel: () => void
  /** Whether the buttons should be disabled (e.g., during processing) */
  disabled?: boolean
  /** Whether this confirmation has already been responded to */
  responded?: boolean
  /** The response that was given (only shown if responded is true) */
  response?: 'confirmed' | 'cancelled'
}

/**
 * Get a human-readable action label
 */
function getActionLabel(action: string): string {
  switch (action) {
    case 'create':
      return 'Create'
    case 'update':
      return 'Update'
    case 'delete':
      return 'Delete'
    case 'transition':
      return 'Transition'
    case 'relationship':
      return 'Add Relationship'
    default:
      return action.charAt(0).toUpperCase() + action.slice(1)
  }
}

/**
 * Get icon color based on action type
 */
function getActionColor(action: string): string {
  switch (action) {
    case 'delete':
      return 'text-red-500'
    case 'transition':
      return 'text-amber-500'
    default:
      return 'text-cyan-500'
  }
}

export function ConfirmationCard({
  message,
  details,
  onConfirm,
  onCancel,
  disabled = false,
  responded = false,
  response,
}: ConfirmationCardProps) {
  // If already responded, show a static card with the result
  if (responded) {
    return (
      <div
        className={cn(
          'rounded-lg border p-3 mt-2',
          response === 'confirmed'
            ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20'
            : 'border-slate-300 bg-slate-50 dark:border-slate-700 dark:bg-slate-800/50',
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          {response === 'confirmed' ? (
            <>
              <Check className="h-4 w-4 text-green-500" />
              <span className="text-green-700 dark:text-green-300">
                Confirmed
              </span>
            </>
          ) : (
            <>
              <X className="h-4 w-4 text-slate-400" />
              <span className="text-slate-500 dark:text-slate-400">
                Cancelled
              </span>
            </>
          )}
          {details && (
            <span className="text-slate-500 dark:text-slate-400">
              - {getActionLabel(details.action)}{' '}
              {details.itemType && details.itemType}{' '}
              {details.itemName && `"${details.itemName}"`}
            </span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 p-3 mt-2">
      {/* Header */}
      <div className="flex items-start gap-2 mb-2">
        <AlertTriangle
          className={cn(
            'h-5 w-5 mt-0.5',
            details ? getActionColor(details.action) : 'text-amber-500',
          )}
        />
        <div className="flex-1">
          <p className="font-medium text-slate-900 dark:text-slate-100 text-sm">
            Confirm Action
          </p>
          <p className="text-slate-600 dark:text-slate-400 text-sm mt-1">
            {message}
          </p>
        </div>
      </div>

      {/* Details */}
      {details && (
        <div className="ml-7 mb-3 text-xs text-slate-600 dark:text-slate-400 space-y-1">
          {details.itemType && (
            <div>
              <span className="font-medium">Type:</span> {details.itemType}
            </div>
          )}
          {details.itemName && (
            <div>
              <span className="font-medium">Name:</span> {details.itemName}
            </div>
          )}
          {details.designName && (
            <div>
              <span className="font-medium">Design:</span> {details.designName}
            </div>
          )}
          {details.changeOrderNumber && (
            <div>
              <span className="font-medium">ECO:</span>{' '}
              {details.changeOrderNumber}
            </div>
          )}
          {details.additionalInfo && details.additionalInfo.length > 0 && (
            <ul className="list-disc list-inside mt-1">
              {details.additionalInfo.map((info, index) => (
                <li key={index}>{info}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Buttons */}
      <div className="flex gap-2 ml-7">
        <Button
          variant="default"
          size="sm"
          onClick={onConfirm}
          disabled={disabled}
          className="bg-cyan-600 hover:bg-cyan-700 text-white"
        >
          <Check className="h-3.5 w-3.5 mr-1" />
          Confirm
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={disabled}
        >
          <X className="h-3.5 w-3.5 mr-1" />
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Type guard for checking if a tool result contains confirmation data
 */
export function isConfirmationResult(result: unknown): result is {
  requiresConfirmation: true
  confirmationMessage?: string
  confirmationDetails?: ConfirmationDetails
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    'requiresConfirmation' in result &&
    (result as any).requiresConfirmation === true
  )
}

/**
 * Type guard for checking if a tool result suggests creating an ECO
 */
export function isSuggestEcoResult(
  result: unknown,
): result is { suggestCreateEco: true; suggestEcoMessage?: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    'suggestCreateEco' in result &&
    (result as any).suggestCreateEco === true
  )
}
