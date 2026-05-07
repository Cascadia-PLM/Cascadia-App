import { Link, useNavigate, useRouterState } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import cascadiaLogo from '/cascadia-plm-logo-icon.svg'
import { ThemeToggle } from './ThemeToggle'
import { Sidebar } from './Sidebar'
import type { UserInfo } from './types'
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
  const [user, setUser] = useState<UserInfo | null>(null)
  const navigate = useNavigate()
  const routerState = useRouterState()
  const currentPath = routerState.location.pathname

  // Check authentication status on mount
  useEffect(() => {
    fetch('/api/v1/auth/session')
      .then((res) => res.json())
      .then((response) => {
        if (response.data?.authenticated) {
          setUser(response.data.user)
        }
      })
      .catch(() => {
        // Ignore errors
      })
  }, [])

  const handleLogout = async () => {
    try {
      await fetch('/api/v1/auth/logout', { method: 'POST' })
      setUser(null)
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
