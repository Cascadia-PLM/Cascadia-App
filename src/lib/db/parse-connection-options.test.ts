import { describe, expect, it, vi } from 'vitest'
import { parseConnectionOptions, resolveSslOption } from './index'

describe('parseConnectionOptions', () => {
  it('passes a plain URL through unchanged', () => {
    const url = 'postgresql://u:p@h:5432/d'
    const result = parseConnectionOptions(url)
    expect(result.connectionString).toBe('postgresql://u:p@h:5432/d')
    expect(result.options).toEqual({})
    expect(result.sslMode).toBeUndefined()
  })

  it('strips ?sslmode=disable and reports the mode', () => {
    const result = parseConnectionOptions(
      'postgresql://u:p@h:5432/d?sslmode=disable',
    )
    expect(result.connectionString).not.toContain('sslmode')
    expect(result.sslMode).toBe('disable')
  })

  it('strips ?sslmode=require and reports the mode', () => {
    const result = parseConnectionOptions(
      'postgresql://u:p@h:5432/d?sslmode=require',
    )
    expect(result.connectionString).not.toContain('sslmode')
    expect(result.sslMode).toBe('require')
  })

  it('accepts verify-ca and verify-full', () => {
    expect(
      parseConnectionOptions('postgresql://u:p@h/d?sslmode=verify-ca').sslMode,
    ).toBe('verify-ca')
    expect(
      parseConnectionOptions('postgresql://u:p@h/d?sslmode=verify-full')
        .sslMode,
    ).toBe('verify-full')
  })

  it('throws on an unsupported sslmode value', () => {
    expect(() =>
      parseConnectionOptions('postgresql://u:p@h/d?sslmode=prefer'),
    ).toThrow(/Invalid sslmode "prefer"/)
  })

  it('extracts cloudsql Unix socket path from ?host=', () => {
    const result = parseConnectionOptions(
      'postgresql://u:p@h/d?host=/cloudsql/project:region:instance',
    )
    expect(result.options.host).toBe('/cloudsql/project:region:instance')
    expect(result.connectionString).not.toContain('host=')
  })

  it('handles cloudsql host AND sslmode in the same URL', () => {
    const result = parseConnectionOptions(
      'postgresql://u:p@h/d?host=/cloudsql/x:y:z&sslmode=disable',
    )
    expect(result.options.host).toBe('/cloudsql/x:y:z')
    expect(result.sslMode).toBe('disable')
    expect(result.connectionString).not.toContain('host=')
    expect(result.connectionString).not.toContain('sslmode')
  })

  it('preserves unrelated query parameters', () => {
    const result = parseConnectionOptions(
      'postgresql://u:p@h/d?sslmode=require&application_name=cascadia',
    )
    expect(result.connectionString).toContain('application_name=cascadia')
    expect(result.connectionString).not.toContain('sslmode')
  })
})

describe('resolveSslOption', () => {
  const readCaFile = vi.fn(() => Buffer.from('FAKE_CA'))

  it('returns no SSL for a Cloud SQL Unix socket regardless of other settings', () => {
    const result = resolveSslOption({
      databaseSslEnv: 'require',
      urlSslMode: 'require',
      isProduction: true,
      isCloudSqlSocket: true,
      caCertPath: '/etc/ca.pem',
      readCaFile,
    })
    expect(result).toEqual({})
  })

  it('honors DATABASE_SSL=disable over URL sslmode=require', () => {
    const result = resolveSslOption({
      databaseSslEnv: 'disable',
      urlSslMode: 'require',
      isProduction: true,
      isCloudSqlSocket: false,
      caCertPath: undefined,
      readCaFile,
    })
    expect(result).toEqual({})
  })

  it('honors URL sslmode=disable when DATABASE_SSL is unset (even in production)', () => {
    const result = resolveSslOption({
      databaseSslEnv: undefined,
      urlSslMode: 'disable',
      isProduction: true,
      isCloudSqlSocket: false,
      caCertPath: undefined,
      readCaFile,
    })
    expect(result).toEqual({})
  })

  it('falls back to "require" in production when nothing else is set', () => {
    const result = resolveSslOption({
      databaseSslEnv: undefined,
      urlSslMode: undefined,
      isProduction: true,
      isCloudSqlSocket: false,
      caCertPath: undefined,
      readCaFile,
    })
    expect(result).toEqual({ ssl: 'require' })
  })

  it('returns no SSL in development when nothing else is set', () => {
    const result = resolveSslOption({
      databaseSslEnv: undefined,
      urlSslMode: undefined,
      isProduction: false,
      isCloudSqlSocket: false,
      caCertPath: undefined,
      readCaFile,
    })
    expect(result).toEqual({})
  })

  it('upgrades "require" to { ca } when DATABASE_CA_CERT_PATH is set', () => {
    const result = resolveSslOption({
      databaseSslEnv: 'require',
      urlSslMode: undefined,
      isProduction: false,
      isCloudSqlSocket: false,
      caCertPath: '/etc/ca.pem',
      readCaFile,
    })
    expect(result).toEqual({ ssl: { ca: Buffer.from('FAKE_CA') } })
  })

  it('throws on verify-ca without DATABASE_CA_CERT_PATH', () => {
    expect(() =>
      resolveSslOption({
        databaseSslEnv: undefined,
        urlSslMode: 'verify-ca',
        isProduction: true,
        isCloudSqlSocket: false,
        caCertPath: undefined,
        readCaFile,
      }),
    ).toThrow(/sslmode=verify-ca requires DATABASE_CA_CERT_PATH/)
  })

  it('throws on verify-full without DATABASE_CA_CERT_PATH', () => {
    expect(() =>
      resolveSslOption({
        databaseSslEnv: undefined,
        urlSslMode: 'verify-full',
        isProduction: true,
        isCloudSqlSocket: false,
        caCertPath: undefined,
        readCaFile,
      }),
    ).toThrow(/sslmode=verify-full requires DATABASE_CA_CERT_PATH/)
  })

  it('accepts verify-full when CA cert path is provided', () => {
    const result = resolveSslOption({
      databaseSslEnv: undefined,
      urlSslMode: 'verify-full',
      isProduction: false,
      isCloudSqlSocket: false,
      caCertPath: '/etc/ca.pem',
      readCaFile,
    })
    expect(result).toEqual({ ssl: { ca: Buffer.from('FAKE_CA') } })
  })

  it('ignores invalid DATABASE_SSL values and falls through to URL mode', () => {
    const result = resolveSslOption({
      databaseSslEnv: 'garbage',
      urlSslMode: 'disable',
      isProduction: true,
      isCloudSqlSocket: false,
      caCertPath: undefined,
      readCaFile,
    })
    expect(result).toEqual({})
  })
})
