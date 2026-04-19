import { HelpCircle } from 'lucide-react'
import { useTour } from '@/lib/tour'

export function StartTourButton() {
  const { startTour, isTourActive } = useTour()

  return (
    <button
      onClick={startTour}
      disabled={isTourActive}
      className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      aria-label="Start guided tour"
      title="Start guided tour"
    >
      <HelpCircle className="w-5 h-5 text-gray-600 dark:text-gray-400" />
    </button>
  )
}
