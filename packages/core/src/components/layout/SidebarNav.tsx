// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

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
  ClipboardList,
  Cpu,
  FileText,
  FlaskConical,
  GitBranch,
  GitFork,
  Hammer,
  HardDrive,
  Home,
  KeyRound,
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
import { useSystemAccess } from '@/lib/hooks/usePermissions'
import { Slot } from '@/lib/ui/slot-registry'

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
  const { canAccess: canAccessSystem, canManage: canManageSystem } =
    useSystemAccess()
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
        <Slot name="designs-nav-items" props={{ onNavClick }} />
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
        to="/software"
        icon={Cpu}
        label="Software"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-software"
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
        to="/test-plans"
        icon={ClipboardList}
        label="Test Plans"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-test-plans"
      />

      <SidebarNavItem
        to="/test-cases"
        icon={FlaskConical}
        label="Test Cases"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-test-cases"
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
        to="/physical-parts"
        icon={Package}
        label="Physical Parts"
        isOpen={isOpen}
        iconSize={iconSize}
        onClick={onNavClick}
        testId="nav-physical-parts"
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

      {/* System Section — hidden entirely from roles without the `system`
          grant, which is Administrator and Power User only. The pages
          behind it guard themselves in `beforeLoad` and every API route
          under them re-checks server-side; this only decides what the
          navigation offers. */}
      {canAccessSystem && (
        <>
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
          {/* Administration is a further step up: every route under
              /admin enforces `system:manage`, which a Power User does
              not hold. */}
          {canManageSystem && (
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
                to="/admin/api-keys"
                icon={KeyRound}
                label="API Keys"
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
          )}
        </>
      )}
    </>
  )
}
