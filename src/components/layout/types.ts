import type { LucideIcon } from 'lucide-react'

export interface UserInfo {
  id: string
  email: string
  name?: string
}

export interface SidebarNavItemProps {
  to: string
  icon: LucideIcon
  label: string
  isOpen: boolean
  iconSize: number
  onClick?: () => void
  testId?: string
  /** For exact route matching (e.g., / should not match /parts) */
  activeOptions?: { exact?: boolean }
}

export interface SidebarSectionProps {
  icon: LucideIcon
  label: string
  basePath: string
  isOpen: boolean
  isExpanded: boolean
  onToggle: () => void
  iconSize: number
  onNavClick?: () => void
  currentPath: string
  children: React.ReactNode
  testId?: string
}

export interface NavSubItemProps {
  to: string
  icon: LucideIcon
  label: string
  onClick?: () => void
  activeOptions?: { exact?: boolean }
  testId?: string
}

export interface SidebarNavProps {
  isOpen: boolean
  onNavClick: () => void
  currentPath: string
  iconSize: number
}

export interface SidebarProps {
  currentPath: string
}

export interface ThemeToggleProps {
  className?: string
}
