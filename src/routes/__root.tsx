import {
  Outlet,
  createRootRoute,
  redirect,
  useLocation,
} from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

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

// Create a client - outside component to avoid recreating on every render
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60, // 1 minute
      refetchOnWindowFocus: false,
    },
  },
})

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    // Skip auth check for login page
    if (location.pathname === '/login') {
      return
    }

    // Client-side auth check via API
    let data: {
      data?: {
        authenticated: boolean
        setupStatus?: { completed: boolean; isGlobalAdmin: boolean }
      }
    }
    try {
      const response = await fetch('/api/v1/auth/session')
      data = await response.json()

      if (!data.data?.authenticated) {
        throw redirect({
          to: '/login',
          search: {
            redirect: location.href,
          },
        })
      }
    } catch (error) {
      // If it's a redirect, re-throw it (this is expected behavior)
      if ((error as any)?.isRedirect) {
        throw error
      }
      // Check for TanStack Router redirect
      if (error && typeof error === 'object' && 'to' in error) {
        throw error
      }
      // For any other error, redirect to login
      console.error('Auth check error:', error)
      throw redirect({
        to: '/login',
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
    const setupStatus = data.data.setupStatus
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
