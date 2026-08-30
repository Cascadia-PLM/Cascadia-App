// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import cascadiaLogo from '/cascadia-plm-logo-icon.svg'
import { ThemeToggle } from './ThemeToggle'
import { Sidebar } from './Sidebar'
import type { UserInfo } from './types'
import { authSessionQuery } from '@/lib/query'
import { apiFetch } from '@/lib/api/client'
import { useSidebar } from '@/lib/sidebar-context'
import { useChatPanel } from '@/lib/ai/chat-context'
import { ProfileDropdown } from '@/components/ProfileDropdown'
import { EnterpriseSearchBar } from '@/components/EnterpriseSearchBar'
import { StartTourButton } from '@/components/tour'
import { Breadcrumbs } from '@/components/navigation/Breadcrumbs'

export function Header() {
  const {
    isOpen: sidebarOpen,
    width: sidebarWidth,
    collapsedWidth: sidebarCollapsedWidth,
  } = useSidebar()
  const { isOpen: chatPanelOpen, width: chatPanelWidth } = useChatPanel()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  // The root route's beforeLoad already primed this, so the header reads the
  // cache rather than firing its own /auth/session on every mount.
  const { data: session } = useQuery(authSessionQuery())
  const sessionUser = session?.authenticated ? session.user : undefined
  const user: UserInfo | null = sessionUser
    ? {
        id: sessionUser.id,
        email: sessionUser.email,
        ...(sessionUser.name !== null ? { name: sessionUser.name } : {}),
      }
    : null

  const handleLogout = async () => {
    try {
      await apiFetch('/api/v1/auth/logout', { method: 'POST' })
      await queryClient.invalidateQueries({ queryKey: ['auth'] })
      navigate({ to: '/login' })
    } catch {
      // Silently fail - user will see they're still logged in
    }
  }

  return (
    <>
      <header
        className="sticky top-0 z-40 h-12 px-4 flex items-center justify-between gap-4 bg-white/95 dark:bg-gray-800/95 backdrop-blur-sm text-gray-900 dark:text-white shadow-md border-b border-gray-300 dark:border-gray-700 transition-[margin] duration-300 ease-in-out"
        style={{
          marginLeft: sidebarOpen ? sidebarWidth : sidebarCollapsedWidth,
          marginRight: chatPanelOpen ? chatPanelWidth : 0,
        }}
      >
        <div className="flex items-center flex-shrink-0">
          <Breadcrumbs />
        </div>

        <div className="flex-1 max-w-2xl mx-auto">
          {user && <EnterpriseSearchBar />}
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <Link
            to="/"
            className="flex items-center gap-1.5 hover:opacity-80 transition-opacity"
          >
            <img src={cascadiaLogo} alt="Cascadia PLM" className="h-6 w-6" />
            <span className="text-base font-bold">Cascadia</span>
            <span className="text-xs text-gray-500 dark:text-gray-400 font-normal">
              PLM
            </span>
          </Link>
          <div className="w-px h-5 bg-gray-300 dark:bg-gray-600" />
          <StartTourButton />
          <ThemeToggle />
          {user && <ProfileDropdown user={user} onLogout={handleLogout} />}
        </div>
      </header>

      <Sidebar currentPath={currentPath} />
    </>
  )
}
