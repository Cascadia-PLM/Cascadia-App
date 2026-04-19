/**
 * Custom React Test Renderer
 *
 * Provides a wrapper that includes all application providers,
 * making it easy to test components in isolation with proper context.
 *
 * @example
 * ```typescript
 * import { renderWithProviders, screen } from '@test/helpers/render'
 *
 * test('renders component', () => {
 *   renderWithProviders(<MyComponent />)
 *   expect(screen.getByText('Hello')).toBeInTheDocument()
 * })
 *
 * // With custom user/permissions
 * test('admin sees admin button', () => {
 *   renderWithProviders(<MyComponent />, {
 *     user: adminUser,
 *     permissions: getPermissionsForRole('Administrator'),
 *   })
 *   expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument()
 * })
 * ```
 */

import React from 'react'
import { render } from '@testing-library/react'
import userEventLib from '@testing-library/user-event'
import type { RenderOptions, RenderResult } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'

type UserEventInstance = ReturnType<typeof userEventLib.setup>

// Re-export everything from testing-library for convenience
export * from '@testing-library/react'
export { default as userEvent } from '@testing-library/user-event'

/**
 * User context type for tests
 */
export interface TestUserContext {
  id: string
  email: string
  name: string | null
}

/**
 * Options for renderWithProviders
 */
export interface RenderWithProvidersOptions extends Omit<
  RenderOptions,
  'wrapper'
> {
  /** Initial route path */
  route?: string
  /** User context for auth-dependent components */
  user?: TestUserContext
  /** User permissions (resource -> actions map) */
  permissions?: Record<string, Array<string>>
  /** Initial theme */
  theme?: 'light' | 'dark' | 'system'
  /** Custom wrapper to add additional providers */
  additionalWrappers?: Array<React.ComponentType<{ children: ReactNode }>>
}

/**
 * Mock theme context for tests
 */
const ThemeContext = React.createContext<{
  theme: 'light' | 'dark' | 'system'
  setTheme: (theme: 'light' | 'dark' | 'system') => void
  resolvedTheme: 'light' | 'dark'
}>({
  theme: 'light',
  setTheme: () => {},
  resolvedTheme: 'light',
})

function MockThemeProvider({
  children,
  theme = 'light',
}: {
  children: ReactNode
  theme?: 'light' | 'dark' | 'system'
}) {
  const [currentTheme, setCurrentTheme] = React.useState(theme)

  return (
    <ThemeContext.Provider
      value={{
        theme: currentTheme,
        setTheme: setCurrentTheme,
        resolvedTheme: currentTheme === 'system' ? 'light' : currentTheme,
      }}
    >
      {children}
    </ThemeContext.Provider>
  )
}

/**
 * Mock toast context for tests
 */
const ToastContext = React.createContext<{
  toasts: Array<{
    id: string
    title: string
    description?: string
    variant?: string
  }>
  addToast: (toast: {
    title: string
    description?: string
    variant?: string
  }) => string
  removeToast: (id: string) => void
  clearToasts: () => void
}>({
  toasts: [],
  addToast: () => '',
  removeToast: () => {},
  clearToasts: () => {},
})

function MockToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = React.useState<
    Array<{ id: string; title: string; description?: string; variant?: string }>
  >([])

  const addToast = React.useCallback(
    (toast: { title: string; description?: string; variant?: string }) => {
      const id = crypto.randomUUID()
      setToasts((prev) => [...prev, { ...toast, id }])
      return id
    },
    [],
  )

  const removeToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const clearToasts = React.useCallback(() => {
    setToasts([])
  }, [])

  return (
    <ToastContext.Provider
      value={{ toasts, addToast, removeToast, clearToasts }}
    >
      {children}
    </ToastContext.Provider>
  )
}

/**
 * Mock alert dialog context for tests
 */
const AlertDialogContext = React.createContext<{
  show: (options: {
    title: string
    description?: string
    onConfirm: () => void
  }) => void
  hide: () => void
}>({
  show: () => {},
  hide: () => {},
})

function MockAlertDialogProvider({ children }: { children: ReactNode }) {
  const show = React.useCallback(() => {}, [])
  const hide = React.useCallback(() => {}, [])

  return (
    <AlertDialogContext.Provider value={{ show, hide }}>
      {children}
    </AlertDialogContext.Provider>
  )
}

/**
 * Mock auth context for tests
 */
export const AuthContext = React.createContext<{
  user: TestUserContext | null
  permissions: Record<string, Array<string>>
  isAuthenticated: boolean
  hasPermission: (resource: string, action: string) => boolean
}>({
  user: null,
  permissions: {},
  isAuthenticated: false,
  hasPermission: () => false,
})

function MockAuthProvider({
  children,
  user,
  permissions = {},
}: {
  children: ReactNode
  user?: TestUserContext
  permissions?: Record<string, Array<string>>
}) {
  const hasPermission = React.useCallback(
    (resource: string, action: string) => {
      const resourcePerms = (permissions as Partial<typeof permissions>)[
        resource
      ]
      return (
        resourcePerms?.includes(action) ||
        resourcePerms?.includes('manage') ||
        false
      )
    },
    [permissions],
  )

  return (
    <AuthContext.Provider
      value={{
        user: user ?? null,
        permissions,
        isAuthenticated: !!user,
        hasPermission,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

/**
 * Compose multiple wrappers into a single wrapper
 */
function composeWrappers(
  wrappers: Array<React.ComponentType<{ children: ReactNode }>>,
): React.ComponentType<{ children: ReactNode }> {
  return ({ children }) => {
    return wrappers.reduceRight(
      (acc, Wrapper) => <Wrapper>{acc}</Wrapper>,
      children,
    )
  }
}

/**
 * All providers wrapper
 */
function AllProviders({
  children,
  options = {},
}: {
  children: ReactNode
  options?: Omit<RenderWithProvidersOptions, keyof RenderOptions>
}) {
  const { user, permissions, theme, additionalWrappers = [] } = options

  // Compose additional wrappers if provided
  const AdditionalWrappersComponent =
    additionalWrappers.length > 0
      ? composeWrappers(additionalWrappers)
      : React.Fragment

  return (
    <MockThemeProvider theme={theme}>
      <MockToastProvider>
        <MockAlertDialogProvider>
          <MockAuthProvider user={user} permissions={permissions}>
            <AdditionalWrappersComponent>
              {children}
            </AdditionalWrappersComponent>
          </MockAuthProvider>
        </MockAlertDialogProvider>
      </MockToastProvider>
    </MockThemeProvider>
  )
}

/**
 * Custom render function that wraps components with all providers
 */
export function renderWithProviders(
  ui: ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult & { user: UserEventInstance } {
  const { user, permissions, theme, additionalWrappers, ...renderOptions } =
    options

  // Create a user event instance
  const userEventInstance = userEventLib.setup()

  const wrapper = ({ children }: { children: ReactNode }) => (
    <AllProviders options={{ user, permissions, theme, additionalWrappers }}>
      {children}
    </AllProviders>
  )

  const result = render(ui, { wrapper, ...renderOptions })

  return {
    ...result,
    user: userEventInstance,
  }
}

/**
 * Render a component with router context
 *
 * Useful for testing components that use router hooks
 */
export function renderWithRouter(
  ui: ReactElement,
  options: RenderWithProvidersOptions & {
    initialEntries?: Array<string>
  } = {},
): RenderResult & { user: UserEventInstance } {
  const { initialEntries: _initialEntries = ['/'], ...restOptions } = options

  // For simple cases, just wrap with providers
  // Full router integration would require more setup
  return renderWithProviders(ui, restOptions)
}

/**
 * Hook to access mock toast context in tests
 */
export function useTestToasts() {
  return React.useContext(ToastContext)
}

/**
 * Hook to access mock auth context in tests
 */
export function useTestAuth() {
  return React.useContext(AuthContext)
}

/**
 * Hook to access mock theme context in tests
 */
export function useTestTheme() {
  return React.useContext(ThemeContext)
}

/**
 * Wait for async updates to complete
 * Useful when testing components with async effects
 */
export async function waitForUpdates(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Create a mock event for testing
 */
export function createMockEvent<T extends Record<string, unknown>>(
  overrides?: T,
): React.SyntheticEvent & T {
  return {
    preventDefault: () => {},
    stopPropagation: () => {},
    target: {},
    currentTarget: {},
    nativeEvent: {} as Event,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    eventPhase: 0,
    isTrusted: true,
    timeStamp: Date.now(),
    type: 'click',
    isDefaultPrevented: () => false,
    isPropagationStopped: () => false,
    persist: () => {},
    ...overrides,
  } as React.SyntheticEvent & T
}

/**
 * Common test user presets
 */
export const testUsers = {
  admin: (): TestUserContext => ({
    id: crypto.randomUUID(),
    email: 'admin@example.com',
    name: 'Admin User',
  }),

  standard: (): TestUserContext => ({
    id: crypto.randomUUID(),
    email: 'user@example.com',
    name: 'Standard User',
  }),

  viewOnly: (): TestUserContext => ({
    id: crypto.randomUUID(),
    email: 'viewer@example.com',
    name: 'View Only User',
  }),
}

/**
 * Common permission presets
 */
export const testPermissions = {
  admin: (): Record<string, Array<string>> => ({
    parts: ['create', 'read', 'update', 'delete', 'approve'],
    documents: ['create', 'read', 'update', 'delete', 'approve'],
    change_orders: ['create', 'read', 'update', 'delete', 'approve'],
    projects: ['create', 'read', 'update', 'delete'],
    requirements: ['create', 'read', 'update', 'delete', 'approve'],
    tasks: ['create', 'read', 'update', 'delete'],
    workflows: ['create', 'read', 'update', 'delete', 'manage'],
    users: ['create', 'read', 'update', 'delete', 'manage'],
    roles: ['create', 'read', 'update', 'delete', 'manage'],
    programs: ['create', 'read', 'update', 'delete', 'manage'],
    reports: ['create', 'read', 'update', 'delete'],
    system: ['read', 'manage'],
  }),

  standard: (): Record<string, Array<string>> => ({
    parts: ['create', 'read', 'update'],
    documents: ['create', 'read', 'update'],
    change_orders: ['create', 'read'],
    projects: ['create', 'read', 'update'],
    requirements: ['create', 'read', 'update'],
    tasks: ['create', 'read', 'update'],
    workflows: ['read'],
    users: ['read'],
    roles: ['read'],
    programs: ['read'],
    reports: ['read'],
    system: ['read'],
  }),

  viewOnly: (): Record<string, Array<string>> => ({
    parts: ['read'],
    documents: ['read'],
    change_orders: ['read'],
    projects: ['read'],
    requirements: ['read'],
    tasks: ['read'],
    workflows: ['read'],
    users: ['read'],
    roles: ['read'],
    programs: ['read'],
    reports: ['read'],
    system: ['read'],
  }),
}
