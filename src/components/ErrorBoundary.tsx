import { Component } from 'react'
import { AlertTriangle, Home, RefreshCw } from 'lucide-react'
import type { ErrorInfo, ReactNode } from 'react'
import { Button } from '@/components/ui/Button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/Card'

interface Props {
  /** The children to render */
  children: ReactNode
  /** Optional fallback UI to render when an error occurs */
  fallback?: ReactNode
  /** Called when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void
  /** If true, show a minimal error UI */
  minimal?: boolean
}

interface State {
  hasError: boolean
  error?: Error
}

/**
 * React Error Boundary component.
 * Catches JavaScript errors anywhere in the child component tree
 * and displays a fallback UI instead of crashing the whole app.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <ErrorBoundary>
 *   <MyComponent />
 * </ErrorBoundary>
 *
 * // With custom fallback
 * <ErrorBoundary fallback={<div>Something went wrong</div>}>
 *   <MyComponent />
 * </ErrorBoundary>
 *
 * // With error logging
 * <ErrorBoundary onError={(error) => logErrorToService(error)}>
 *   <MyComponent />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[ErrorBoundary]', error, errorInfo)
    this.props.onError?.(error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined })
  }

  handleReload = () => {
    window.location.reload()
  }

  handleHome = () => {
    window.location.href = '/'
  }

  render() {
    if (this.state.hasError) {
      // Use custom fallback if provided
      if (this.props.fallback) {
        return this.props.fallback
      }

      // Minimal error UI
      if (this.props.minimal) {
        return (
          <div className="flex items-center gap-2 p-4 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            <span>Something went wrong</span>
            <Button size="sm" variant="ghost" onClick={this.handleRetry}>
              Try again
            </Button>
          </div>
        )
      }

      // Full error UI
      return (
        <div className="flex items-center justify-center min-h-[400px] p-4">
          <Card className="w-full max-w-md">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
                Something went wrong
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-muted-foreground">
                An unexpected error occurred. Please try again or contact
                support if the problem persists.
              </p>
              {process.env.NODE_ENV === 'development' && this.state.error && (
                <div className="mt-4">
                  <p className="text-sm font-medium text-destructive mb-2">
                    Error details:
                  </p>
                  <pre className="p-3 bg-muted rounded-lg text-xs overflow-auto max-h-40">
                    {this.state.error.message}
                    {'\n\n'}
                    {this.state.error.stack}
                  </pre>
                </div>
              )}
            </CardContent>
            <CardFooter className="flex gap-2">
              <Button onClick={this.handleRetry} className="flex-1">
                <RefreshCw className="h-4 w-4 mr-2" />
                Try Again
              </Button>
              <Button
                variant="outline"
                onClick={this.handleReload}
                className="flex-1"
              >
                Reload Page
              </Button>
              <Button variant="ghost" onClick={this.handleHome} size="icon">
                <Home className="h-4 w-4" />
              </Button>
            </CardFooter>
          </Card>
        </div>
      )
    }

    return this.props.children
  }
}

/**
 * A simpler error boundary for inline components.
 * Shows a minimal error message with a retry button.
 */
export class InlineErrorBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  State
> {
  state: State = { hasError: false }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[InlineErrorBoundary]', error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: undefined })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div className="flex items-center gap-2 p-2 text-sm text-destructive bg-destructive/10 rounded">
          <AlertTriangle className="h-4 w-4 flex-shrink-0" />
          <span className="flex-1">Failed to load</span>
          <button
            type="button"
            onClick={this.handleRetry}
            className="font-medium hover:underline"
          >
            Retry
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
