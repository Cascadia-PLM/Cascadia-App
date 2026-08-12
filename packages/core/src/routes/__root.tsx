// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  Outlet,
  createRootRouteWithContext,
  redirect,
  useLocation,
} from '@tanstack/react-router'
import { QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { queryClient } from '../lib/query/client'
import { authSessionQuery } from '../lib/query/options/auth'

import { Header } from '../components/layout'
import { ThemeProvider } from '../lib/theme'
import { SidebarProvider, useSidebar } from '../lib/sidebar-context'
import { AlertDialogProvider } from '../lib/hooks/useAlertDialog'
import { ToastProvider } from '../lib/hooks/useToast'
import { ToastContainer } from '../components/ui/ToastContainer'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { ChatPanelProvider, useChatPanel } from '../lib/ai/chat-context'
import { ChatPanel, ChatPanelButton } from '../components/ai'
import { TourProvider } from '../lib/tour'
import type { QueryClient } from '@tanstack/react-query'

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async ({ location, context }) => {
    // Skip auth check for login page
    if (location.pathname === '/login') {
      return
    }

    // Client-side auth check, read through the shared cache so a burst of
    // navigations doesn't re-probe the session for every segment.
    //
    // `fetchQuery`, not `ensureQueryData`: this read decides a redirect, so it
    // has to honour invalidation. `ensureQueryData` returns whatever is cached
    // whenever an entry exists — stale or freshly invalidated, it never
    // refetches (`revalidateIfStale` defaults to false). Nothing mounts an
    // observer on this query during the setup wizard, so the wizard's
    // `invalidates: ['setup']` (which fans out to `auth`) only marked the entry
    // stale and left `completed: false` in place; the navigate to `/` that
    // follows then read it back and bounced straight to /setup. `fetchQuery`
    // honours both `staleTime` and invalidation, so the burst-dedup this cache
    // read exists for survives while a completed wizard is seen immediately.
    const session = await context.queryClient.fetchQuery(authSessionQuery())

    if (!session.authenticated) {
      throw redirect({
        to: '/login',
        search: {
          redirect: location.href,
        },
      })
    }

    // First-time setup wizard redirect: a Global Admin landing on any
    // authenticated page is bounced to /setup until either the admin
    // finishes/skips the wizard or the SETUP_COMPLETED flag is otherwise
    // set. /setup itself, /login, and /api/* are exempt; E2E tests opt
    // out via the same localStorage key the existing tour uses.
    const path = location.pathname
    const isExempt =
      path === '/login' || path === '/setup' || path.startsWith('/api/')
    const isE2E =
      typeof window !== 'undefined' &&
      window.localStorage.getItem('cascadia-e2e-test') === 'true'
    const setupStatus = session.setupStatus
    if (
      !isExempt &&
      !isE2E &&
      setupStatus &&
      setupStatus.isGlobalAdmin &&
      !setupStatus.completed
    ) {
      throw redirect({ to: '/setup' })
    }
  },

  component: RootLayout,
})

function MainContent({
  children,
  isMounted,
}: {
  children: React.ReactNode
  isMounted: boolean
}) {
  const {
    isOpen: sidebarOpen,
    width: sidebarWidth,
    collapsedWidth: sidebarCollapsedWidth,
  } = useSidebar()
  const { isOpen: chatPanelOpen, width: chatPanelWidth } = useChatPanel()

  // Only apply margin after mount to avoid hydration mismatch
  // Sidebar is always visible: dynamic width when open, collapsed width when collapsed
  // Chat panel: dynamic width when open, 0 when collapsed
  const marginLeft = isMounted
    ? sidebarOpen
      ? sidebarWidth
      : sidebarCollapsedWidth
    : 0
  const marginRight = isMounted ? (chatPanelOpen ? chatPanelWidth : 0) : 0

  return (
    <main
      className="transition-[margin] duration-300 ease-in-out"
      style={{ marginLeft, marginRight }}
    >
      {children}
    </main>
  )
}

function RootLayout() {
  const location = useLocation()
  const [isMounted, setIsMounted] = useState(false)

  useEffect(() => {
    setIsMounted(true)
  }, [])

  const isLoginPage = location.pathname === '/login'
  // The setup wizard owns its viewport — no global header, sidebar
  // margin, or chat panel chrome — same treatment as /login.
  const isSetupPage = location.pathname === '/setup'
  const isChromelessPage = isLoginPage || isSetupPage

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SidebarProvider>
          <ToastProvider>
            <AlertDialogProvider>
              <ChatPanelProvider>
                <TourProvider>
                  <ErrorBoundary>
                    {isMounted && !isChromelessPage && <Header />}
                    {isChromelessPage ? (
                      <Outlet />
                    ) : (
                      <MainContent isMounted={isMounted}>
                        <Outlet />
                      </MainContent>
                    )}
                  </ErrorBoundary>
                  <ToastContainer />
                  {/* AI Chat Panel - only show when authenticated and on a chromed page */}
                  {isMounted && !isChromelessPage && (
                    <>
                      <ChatPanelButton />
                      <ChatPanel />
                    </>
                  )}
                </TourProvider>
              </ChatPanelProvider>
            </AlertDialogProvider>
          </ToastProvider>
        </SidebarProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
