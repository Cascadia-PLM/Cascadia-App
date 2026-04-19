/**
 * Session cookie builders with conditional Secure flag.
 *
 * In production, cookies include the Secure flag to ensure
 * they are only sent over HTTPS connections.
 */

interface CookieOptions {
  name: string
  value: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  maxAge?: number
}

function buildCookie(options: CookieOptions): string {
  const parts = [`${options.name}=${options.value}`]
  if (options.path) parts.push(`Path=${options.path}`)
  if (options.httpOnly) parts.push('HttpOnly')
  if (options.secure) parts.push('Secure')
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`)
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`)
  return parts.join('; ')
}

export function buildSessionCookie(token: string): string {
  return buildCookie({
    name: 'session',
    value: token,
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge: 28800,
  })
}

export function buildClearSessionCookie(): string {
  return buildCookie({
    name: 'session',
    value: '',
    path: '/',
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Strict',
    maxAge: 0,
  })
}
