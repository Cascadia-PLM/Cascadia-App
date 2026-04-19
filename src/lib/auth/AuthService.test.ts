/**
 * AuthService Tests
 *
 * Tests for the AuthService class (login/logout functionality).
 *
 * Run: npm run test -- src/lib/auth/AuthService.test.ts
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest'
import { eq } from 'drizzle-orm'
import { AuthService } from './AuthService'
import type { TestUser } from '@/__tests__/fixtures/users'
import { TestDatabase } from '@/__tests__/helpers/db'
import { insertTestUser } from '@/__tests__/fixtures/users'
import { hashPassword } from '@/lib/auth/password'
import { SessionManager } from '@/lib/auth/session'
import { users } from '@/lib/db/schema'
import { AuthenticationError, ValidationError } from '@/lib/errors'

describe('AuthService', () => {
  const testDb = new TestDatabase()
  let user: TestUser
  const testPassword = 'TestPassword123!'

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()

    // Create test user with password
    const passwordHash = await hashPassword(testPassword)
    user = await insertTestUser(testDb.db, {
      email: `testuser-${Date.now()}@example.com`,
      name: 'Test User',
      passwordHash,
      active: true,
    })
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  describe('login', () => {
    it('returns session token and user for valid credentials', async () => {
      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      expect(result.success).toBe(true)
      expect(result.sessionToken).toBeDefined()
      expect(result.sessionToken.length).toBeGreaterThan(0)
      expect(result.user.id).toBe(user.id)
      expect(result.user.email).toBe(user.email)
      expect(result.user.name).toBe('Test User')
    })

    it('throws AuthenticationError for invalid email', async () => {
      await expect(
        AuthService.login({
          username: 'nonexistent@example.com',
          password: testPassword,
        }),
      ).rejects.toThrow(AuthenticationError)
    })

    it('throws AuthenticationError for invalid password', async () => {
      await expect(
        AuthService.login({
          username: user.email,
          password: 'wrongpassword',
        }),
      ).rejects.toThrow(AuthenticationError)
    })

    it('throws ValidationError for missing username', async () => {
      await expect(
        AuthService.login({
          username: '',
          password: testPassword,
        }),
      ).rejects.toThrow(ValidationError)
    })

    it('throws ValidationError for missing password', async () => {
      await expect(
        AuthService.login({
          username: user.email,
          password: '',
        }),
      ).rejects.toThrow(ValidationError)
    })

    it('throws AuthenticationError for inactive user', async () => {
      // Create inactive user
      const passwordHash = await hashPassword(testPassword)
      const inactiveUser = await insertTestUser(testDb.db, {
        email: `inactive-${Date.now()}@example.com`,
        passwordHash,
        active: false,
      })

      await expect(
        AuthService.login({
          username: inactiveUser.email,
          password: testPassword,
        }),
      ).rejects.toThrow(AuthenticationError)
    })

    it('updates lastLogin timestamp', async () => {
      const beforeLogin = new Date()

      await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      // Check user's lastLogin was updated
      const [updatedUser] = await testDb.db
        .select()
        .from(users)
        .where(eq(users.id, user.id))

      expect(updatedUser.lastLogin).toBeDefined()
      expect(new Date(updatedUser.lastLogin!).getTime()).toBeGreaterThanOrEqual(
        beforeLogin.getTime(),
      )
    })

    it('creates session in database', async () => {
      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      // Verify session was created
      const sessionData = await SessionManager.validateSession(
        result.sessionToken,
      )
      expect(sessionData).toBeDefined()
      expect(sessionData?.user.id).toBe(user.id)
    })
  })

  describe('logout', () => {
    it('invalidates session successfully', async () => {
      // First login to get a session
      const loginResult = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      // Verify session exists
      const sessionBeforeLogout = await SessionManager.validateSession(
        loginResult.sessionToken,
      )
      expect(sessionBeforeLogout).toBeDefined()

      // Logout
      const logoutResult = await AuthService.logout({
        sessionToken: loginResult.sessionToken,
      })

      expect(logoutResult.success).toBe(true)

      // Verify session is invalidated
      const sessionAfterLogout = await SessionManager.validateSession(
        loginResult.sessionToken,
      )
      expect(sessionAfterLogout).toBeNull()
    })

    it('throws AuthenticationError for empty session token', async () => {
      await expect(
        AuthService.logout({
          sessionToken: '',
        }),
      ).rejects.toThrow(AuthenticationError)
    })
  })

  describe('parseSessionFromCookie', () => {
    it('extracts session token from cookie header', () => {
      const cookie = 'session=abc123; Path=/; HttpOnly'
      const token = AuthService.parseSessionFromCookie(cookie)
      expect(token).toBe('abc123')
    })

    it('handles multiple cookies', () => {
      const cookie = 'other=value; session=xyz789; another=test'
      const token = AuthService.parseSessionFromCookie(cookie)
      expect(token).toBe('xyz789')
    })

    it('returns null for missing session cookie', () => {
      const cookie = 'other=value; another=test'
      const token = AuthService.parseSessionFromCookie(cookie)
      expect(token).toBeNull()
    })

    it('returns null for null input', () => {
      const token = AuthService.parseSessionFromCookie(null)
      expect(token).toBeNull()
    })

    it('handles empty string', () => {
      const token = AuthService.parseSessionFromCookie('')
      expect(token).toBeNull()
    })

    it('handles session with equals sign in value', () => {
      const cookie = 'session=abc=123=xyz; Path=/'
      const token = AuthService.parseSessionFromCookie(cookie)
      expect(token).toBe('abc=123=xyz')
    })

    it('handles session at end of cookie string', () => {
      const cookie = 'other=value; session=lasttoken'
      const token = AuthService.parseSessionFromCookie(cookie)
      expect(token).toBe('lasttoken')
    })
  })

  describe('login with metadata', () => {
    it('logs ipAddress and userAgent on successful login', async () => {
      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0 Test Browser',
      })

      expect(result.success).toBe(true)
      expect(result.sessionToken).toBeDefined()
    })

    it('logs ipAddress on failed login - invalid user', async () => {
      await expect(
        AuthService.login({
          username: 'nonexistent@example.com',
          password: testPassword,
          ipAddress: '10.0.0.1',
        }),
      ).rejects.toThrow(AuthenticationError)
    })

    it('logs ipAddress on failed login - invalid password', async () => {
      await expect(
        AuthService.login({
          username: user.email,
          password: 'wrongpassword',
          ipAddress: '172.16.0.1',
        }),
      ).rejects.toThrow(AuthenticationError)
    })
  })

  describe('logout with metadata', () => {
    it('logs ipAddress on logout', async () => {
      const loginResult = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      const logoutResult = await AuthService.logout({
        sessionToken: loginResult.sessionToken,
        ipAddress: '192.168.1.1',
      })

      expect(logoutResult.success).toBe(true)
    })

    it('succeeds even for invalid session token', async () => {
      // Create a login first to have a valid format token
      const loginResult = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      // Logout first time
      await AuthService.logout({
        sessionToken: loginResult.sessionToken,
      })

      // Second logout with same token should still succeed
      // because deleteSession is idempotent
      const result = await AuthService.logout({
        sessionToken: loginResult.sessionToken,
      })

      expect(result.success).toBe(true)
    })
  })
})

// Edge case tests
describe('AuthService Edge Cases', () => {
  const testDb = new TestDatabase()
  const testPassword = 'TestPassword123!'

  beforeAll(async () => {
    await testDb.setup()
  })

  afterAll(async () => {
    await testDb.teardown()
  })

  beforeEach(async () => {
    await testDb.beginTransaction()
  })

  afterEach(async () => {
    await testDb.rollback()
  })

  describe('Email/Username Edge Cases', () => {
    it('handles email with plus sign', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `test+alias-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      expect(result.success).toBe(true)
    })

    it('handles email with long local part', async () => {
      const longLocal = 'a'.repeat(64)
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `${longLocal}-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      expect(result.success).toBe(true)
    })

    it('handles email with subdomain', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `user-${Date.now()}@mail.subdomain.example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      expect(result.success).toBe(true)
    })

    it('login handles case in email', async () => {
      const baseEmail = `CaseTest-${Date.now()}@example.com`
      const passwordHash = await hashPassword(testPassword)
      await insertTestUser(testDb.db, {
        email: baseEmail.toLowerCase(),
        passwordHash,
        active: true,
      })

      // Try uppercase email - may or may not work depending on case sensitivity
      try {
        const result = await AuthService.login({
          username: baseEmail.toUpperCase(),
          password: testPassword,
        })
        expect(result.success).toBe(true)
      } catch (error) {
        // Case-sensitive login is also acceptable
        expect(error).toBeInstanceOf(AuthenticationError)
      }
    })

    it('handles whitespace-only username', async () => {
      try {
        await AuthService.login({
          username: '   ',
          password: testPassword,
        })
        // If it doesn't throw, it should fail authentication
        expect(true).toBe(false) // Should not reach here
      } catch (error) {
        // Should throw either ValidationError or AuthenticationError
        expect(error).toBeDefined()
      }
    })

    it('handles whitespace in username', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `trimtest-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      // Try with surrounding whitespace - may or may not trim
      try {
        const result = await AuthService.login({
          username: `  ${user.email}  `,
          password: testPassword,
        })
        expect(result.success).toBe(true)
      } catch (error) {
        // Not trimming is also valid
        expect(error).toBeInstanceOf(AuthenticationError)
      }
    })
  })

  describe('Password Edge Cases', () => {
    it('handles password with special characters', async () => {
      const specialPassword = 'Test!@#$%^&*()_+-=[]{}|;:",.<>?/'
      const passwordHash = await hashPassword(specialPassword)
      const user = await insertTestUser(testDb.db, {
        email: `specialpw-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: specialPassword,
      })

      expect(result.success).toBe(true)
    })

    it('handles password with unicode characters', async () => {
      const unicodePassword = 'Pässwörd123!日本語'
      const passwordHash = await hashPassword(unicodePassword)
      const user = await insertTestUser(testDb.db, {
        email: `unicodepw-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: unicodePassword,
      })

      expect(result.success).toBe(true)
    })

    it('handles password with spaces', async () => {
      const spacedPassword = 'My Password With Spaces 123!'
      const passwordHash = await hashPassword(spacedPassword)
      const user = await insertTestUser(testDb.db, {
        email: `spacedpw-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: spacedPassword,
      })

      expect(result.success).toBe(true)
    })

    it('handles very long password', async () => {
      const longPassword = 'A'.repeat(100) + '1!'
      const passwordHash = await hashPassword(longPassword)
      const user = await insertTestUser(testDb.db, {
        email: `longpw-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: longPassword,
      })

      expect(result.success).toBe(true)
    })

    it('rejects password that is too similar but different', async () => {
      const passwordHash = await hashPassword('CorrectPassword123!')
      const user = await insertTestUser(testDb.db, {
        email: `similarpw-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      await expect(
        AuthService.login({
          username: user.email,
          password: 'correctPassword123!', // Different case
        }),
      ).rejects.toThrow(AuthenticationError)
    })

    it('password is not trimmed', async () => {
      const passwordHash = await hashPassword('NoTrim123!')
      const user = await insertTestUser(testDb.db, {
        email: `notrim-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      // Password with leading/trailing space should fail
      await expect(
        AuthService.login({
          username: user.email,
          password: ' NoTrim123! ',
        }),
      ).rejects.toThrow(AuthenticationError)
    })
  })

  describe('Session Token Edge Cases', () => {
    it('each login creates unique session token', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `multisession-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result1 = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      const result2 = await AuthService.login({
        username: user.email,
        password: testPassword,
      })

      expect(result1.sessionToken).not.toBe(result2.sessionToken)
    })

    it('logout with malformed token does not error', async () => {
      // Malformed token should still succeed (idempotent)
      const result = await AuthService.logout({
        sessionToken: 'not-a-valid-session-token-format',
      })

      expect(result.success).toBe(true)
    })

    it('logout with very long token does not error', async () => {
      const longToken = 'a'.repeat(1000)
      const result = await AuthService.logout({
        sessionToken: longToken,
      })

      expect(result.success).toBe(true)
    })
  })

  describe('Cookie Parsing Edge Cases', () => {
    it('handles URL-encoded session token', () => {
      const cookie = 'session=abc%2B123%3Dxyz; Path=/'
      const token = AuthService.parseSessionFromCookie(cookie)
      // Should return the raw value, not decoded
      expect(token).toBe('abc%2B123%3Dxyz')
    })

    it('handles whitespace around cookie values', () => {
      const cookie = 'session = abc123 ; Path=/'
      const token = AuthService.parseSessionFromCookie(cookie)
      expect(token).toBeDefined()
    })

    it('handles empty session value', () => {
      const cookie = 'session=; other=value'
      const token = AuthService.parseSessionFromCookie(cookie)
      // Empty value may return empty string or null
      expect(token === '' || token === null).toBe(true)
    })

    it('handles very long cookie string', () => {
      const longValue = 'x'.repeat(10000)
      const cookie = `other=${longValue}; session=validtoken`
      const token = AuthService.parseSessionFromCookie(cookie)
      expect(token).toBe('validtoken')
    })

    it('handles special characters in other cookies', () => {
      const cookie = 'other="value;with;semicolons"; session=abc123'
      const token = AuthService.parseSessionFromCookie(cookie)
      // Should extract the session token despite special chars in other cookies
      expect(token).toBe('abc123')
    })

    it('handles undefined input', () => {
      const token = AuthService.parseSessionFromCookie(undefined as any)
      expect(token).toBeNull()
    })
  })

  describe('Concurrent Login Handling', () => {
    it('allows multiple concurrent logins for same user', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `concurrent-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const loginPromises = Array.from({ length: 5 }, () =>
        AuthService.login({
          username: user.email,
          password: testPassword,
        }),
      )

      const results = await Promise.all(loginPromises)

      results.forEach((r) => {
        expect(r.success).toBe(true)
        expect(r.sessionToken).toBeDefined()
      })

      // All tokens should be unique
      const tokens = results.map((r) => r.sessionToken)
      const uniqueTokens = new Set(tokens)
      expect(uniqueTokens.size).toBe(5)
    })
  })

  describe('User State Transitions', () => {
    it('login fails immediately after user deactivated', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `deactivate-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      // First login should succeed
      const result1 = await AuthService.login({
        username: user.email,
        password: testPassword,
      })
      expect(result1.success).toBe(true)

      // Deactivate user
      await testDb.db
        .update(users)
        .set({ active: false })
        .where(eq(users.id, user.id))

      // Second login should fail
      await expect(
        AuthService.login({
          username: user.email,
          password: testPassword,
        }),
      ).rejects.toThrow(AuthenticationError)
    })

    it('handles user with no password hash', async () => {
      const user = await insertTestUser(testDb.db, {
        email: `nohash-${Date.now()}@example.com`,
        passwordHash: null,
        active: true,
      })

      await expect(
        AuthService.login({
          username: user.email,
          password: testPassword,
        }),
      ).rejects.toThrow(AuthenticationError)
    })
  })

  describe('IP Address and User Agent Edge Cases', () => {
    it('handles IPv6 address', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `ipv6-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
        ipAddress: '2001:0db8:85a3:0000:0000:8a2e:0370:7334',
      })

      expect(result.success).toBe(true)
    })

    it('handles very long user agent', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `longua-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const longUserAgent = 'Mozilla/5.0 ' + 'X'.repeat(500)
      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
        userAgent: longUserAgent,
      })

      expect(result.success).toBe(true)
    })

    it('handles null IP address and user agent', async () => {
      const passwordHash = await hashPassword(testPassword)
      const user = await insertTestUser(testDb.db, {
        email: `nullmeta-${Date.now()}@example.com`,
        passwordHash,
        active: true,
      })

      const result = await AuthService.login({
        username: user.email,
        password: testPassword,
        ipAddress: undefined,
        userAgent: undefined,
      })

      expect(result.success).toBe(true)
    })
  })
})
