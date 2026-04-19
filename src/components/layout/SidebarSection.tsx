import { Link } from '@tanstack/react-router'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { SidebarSectionProps } from './types'

export function SidebarSection({
  icon: Icon,
  label,
  basePath,
  isOpen,
  isExpanded,
  onToggle,
  iconSize,
  onNavClick,
  currentPath,
  children,
  testId,
}: SidebarSectionProps) {
  const isActive = currentPath.startsWith(basePath)

  if (!isOpen) {
    // Collapsed sidebar: show just the icon as a link
    return (
      <div className="mb-2">
        <Link
          to={basePath}
          onClick={onNavClick}
          className={`flex items-center justify-center p-3 rounded-lg transition-colors ${
            isActive
              ? 'bg-cyan-500 dark:bg-cyan-600 hover:bg-cyan-600 dark:hover:bg-cyan-700 text-white'
              : 'hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
          title={label}
        >
          <Icon size={iconSize} />
        </Link>
      </div>
    )
  }

  // Expanded sidebar: show collapsible section
  return (
    <div className="mb-2">
      <button
        onClick={onToggle}
        className={`w-full flex items-center gap-3 p-3 rounded-lg transition-colors ${
          isActive
            ? 'bg-cyan-500 dark:bg-cyan-600 hover:bg-cyan-600 dark:hover:bg-cyan-700 text-white'
            : 'hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
        data-testid={testId}
      >
        <Icon size={20} />
        <span className="font-medium flex-1 text-left">{label}</span>
        {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {isExpanded && (
        <div className="ml-6 mt-1 border-l-2 border-gray-300 dark:border-gray-700 pl-2">
          {children}
        </div>
      )}
    </div>
  )
}
