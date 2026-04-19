import { Link } from '@tanstack/react-router'
import type { SidebarNavItemProps } from './types'

export function SidebarNavItem({
  to,
  icon: Icon,
  label,
  isOpen,
  iconSize,
  onClick,
  testId,
  activeOptions,
}: SidebarNavItemProps) {
  const baseClasses = `flex items-center rounded-lg transition-colors mb-2 ${
    isOpen ? 'gap-3 p-3' : 'justify-center p-3'
  }`

  const inactiveClasses = `${baseClasses} hover:bg-gray-100 dark:hover:bg-gray-800`
  const activeClasses = `${baseClasses} bg-cyan-500 dark:bg-cyan-600 hover:bg-cyan-600 dark:hover:bg-cyan-700 text-white`

  return (
    <Link
      to={to}
      onClick={onClick}
      className={inactiveClasses}
      activeProps={{ className: activeClasses }}
      activeOptions={activeOptions}
      data-testid={testId}
      title={isOpen ? undefined : label}
    >
      <Icon size={iconSize} />
      {isOpen && <span className="font-medium">{label}</span>}
    </Link>
  )
}
