import { useEffect, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Box,
  Briefcase,
  CheckSquare,
  ClipboardCheck,
  FileText,
  GitBranch,
  GitFork,
  Hammer,
  HardDrive,
  Home,
  Layers,
  ListChecks,
  Package,
  RotateCcw,
  Settings,
  Shield,
  Users,
  Wrench,
} from 'lucide-react'
import { SidebarNavItem } from './SidebarNavItem'
import { SidebarSection } from './SidebarSection'
import { NavSubItem } from './NavSubItem'
import type { SidebarNavProps } from './types'

function SectionHeader({ label, isOpen }: { label: string; isOpen: boolean }) {
  if (isOpen) {
    return (
      <div className="mt-6 mb-2 px-3 text-xs font-semibold text-gray-500 dark:text-gray-500 uppercase tracking-wider">
        {label}
      </div>
    )
  }
  return <div className="my-2 border-t border-gray-300 dark:border-gray-700" />
}

export function SidebarNav({
  isOpen,
  onNavClick,
  currentPath,
  iconSize,
}: SidebarNavProps) {
  const [adminExpanded, setAdminExpanded] = useState(false)
  const [designsExpanded, setDesignsExpanded] = useState(false)

  // Auto-expand admin section when on admin routes
  useEffect(() => {
    if (currentPath.startsWith('/admin')) {
      setAdminExpanded(true)
    }
  }, [currentPath])

  // Auto-expand designs section when on designs routes
  useEffect(() => {
    if (currentPath.startsWith('/designs')) {
      setDesignsExpanded(true)
    }
  }, [currentPath])

  return (
    <>
      {/* Dashboard */}
      <SidebarNavItem
        to="/"
        icon={Home}
        label="Dashboard"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-dashboard"
        activeOptions={{ exact: true }}
      />

      {/* Organization Section */}
      <SectionHeader label="Organization" isOpen={isOpen} />

      <SidebarNavItem
        to="/programs"
        icon={Briefcase}
        label="Programs"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-programs"
      />

      <SidebarSection
        icon={Box}
        label="Designs"
        basePath="/designs"
        isOpen={isOpen}
        isExpanded={designsExpanded}
        onToggle={() => setDesignsExpanded(!designsExpanded)}
        iconSize={iconSize}
        onNavClick={onNavClick}
        currentPath={currentPath}
        testId="nav-designs-expand"
      >
        <NavSubItem
          to="/designs"
          icon={Box}
          label="All Designs"
          onClick={onNavClick}
          activeOptions={{ exact: true }}
          testId="nav-designs"
        />
        <NavSubItem
          to="/designs/workspaces"
          icon={GitFork}
          label="My Workspaces"
          onClick={onNavClick}
        />
      </SidebarSection>

      {/* Items Section */}
      <SectionHeader label="Items" isOpen={isOpen} />

      <SidebarNavItem
        to="/change-orders"
        icon={GitBranch}
        label="Change Orders"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-change-orders"
      />

      <SidebarNavItem
        to="/parts"
        icon={Package}
        label="Parts"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-parts"
      />

      <SidebarNavItem
        to="/documents"
        icon={FileText}
        label="Documents"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-documents"
      />

      <SidebarNavItem
        to="/requirements"
        icon={ListChecks}
        label="Requirements"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
      />

      <SidebarNavItem
        to="/issues"
        icon={AlertTriangle}
        label="Issues"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-issues"
      />

      <SidebarNavItem
        to="/tasks"
        icon={CheckSquare}
        label="Tasks"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
      />

      <SidebarNavItem
        to="/work-orders"
        icon={Wrench}
        label="Work Orders"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-work-orders"
      />

      <SidebarNavItem
        to="/work-instructions"
        icon={ClipboardCheck}
        label="Work Instructions"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-work-instructions"
      />

      <SidebarNavItem
        to="/tools"
        icon={Hammer}
        label="Tools"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-tools"
      />

      <SidebarNavItem
        to="/files"
        icon={HardDrive}
        label="Files"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-files"
      />

      {/* Analytics Section */}
      <SectionHeader label="Analytics" isOpen={isOpen} />

      <SidebarNavItem
        to="/reports"
        icon={BarChart3}
        label="Reports"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
      />

      {/* System Section */}
      <SectionHeader label="System" isOpen={isOpen} />

      <SidebarNavItem
        to="/lifecycles"
        icon={RotateCcw}
        label="Lifecycles"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
      />

      <SidebarNavItem
        to="/users"
        icon={Users}
        label="Users"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
      />

      <SidebarSection
        icon={Settings}
        label="Administration"
        basePath="/admin"
        isOpen={isOpen}
        isExpanded={adminExpanded}
        onToggle={() => setAdminExpanded(!adminExpanded)}
        iconSize={iconSize}
        onNavClick={onNavClick}
        currentPath={currentPath}
      >
        <NavSubItem
          to="/admin"
          icon={Settings}
          label="Settings"
          onClick={onNavClick}
          activeOptions={{ exact: true }}
        />
        <NavSubItem
          to="/admin/roles"
          icon={Shield}
          label="Roles & Permissions"
          onClick={onNavClick}
        />
        <NavSubItem
          to="/admin/item-types"
          icon={Layers}
          label="Item Types"
          onClick={onNavClick}
        />
        <NavSubItem
          to="/admin/jobs"
          icon={Activity}
          label="Jobs"
          onClick={onNavClick}
        />
        <NavSubItem
          to="/admin/ai"
          icon={Bot}
          label="AI Assistant"
          onClick={onNavClick}
        />
      </SidebarSection>
    </>
  )
}
