import { Link } from '@tanstack/react-router'
import type { NavSubItemProps } from './types'

export function NavSubItem({
  to,
  icon: Icon,
  label,
  onClick,
  activeOptions,
  testId,
}: NavSubItemProps) {
  const baseClasses =
    'flex items-center gap-3 p-2 rounded-lg transition-colors mb-1 text-sm'
  const inactiveClasses = `${baseClasses} hover:bg-gray-100 dark:hover:bg-gray-800`
  const activeClasses = `${baseClasses} bg-cyan-100 dark:bg-cyan-900/50 text-cyan-700 dark:text-cyan-300 hover:bg-cyan-100 dark:hover:bg-cyan-900/50`

  return (
    <Link
      to={to}
      onClick={onClick}
      activeOptions={activeOptions}
      className={inactiveClasses}
      activeProps={{ className: activeClasses }}
      data-testid={testId}
    >
      <Icon size={16} />
      <span className="font-medium">{label}</span>
    </Link>
  )
}
