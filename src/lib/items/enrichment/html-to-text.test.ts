import { assertSafeUrl } from './html-to-text'
import { ValidationError } from '@/lib/errors'

/**
 * SSRF boundary: link enrichment fetches an arbitrary user-supplied URL
 * server-side, so `assertSafeUrl` must reject anything that could reach the
 * internal network or use a non-web scheme. (Three-gate rule: security.)
 */
describe('assertSafeUrl', () => {
  it('accepts public http and https URLs', () => {
    expect(assertSafeUrl('https://example.com/product/123').hostname).toBe(
      'example.com',
    )
    expect(assertSafeUrl('http://8.8.8.8/page').hostname).toBe('8.8.8.8')
    expect(
      assertSafeUrl('https://sub.vendor.co.uk/spec?id=5').hostname,
    ).toBe('sub.vendor.co.uk')
  })

  it('rejects non-http(s) schemes', () => {
    for (const url of [
      'ftp://example.com/file',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>hi</h1>',
    ]) {
      expect(() => assertSafeUrl(url)).toThrow(ValidationError)
    }
  })

  it('rejects loopback and unspecified hosts', () => {
    for (const url of [
      'http://localhost/x',
      'http://api.localhost/x',
      'http://127.0.0.1/x',
      'http://127.9.9.9/x',
      'http://0.0.0.0/x',
      'http://[::1]/x',
    ]) {
      expect(() => assertSafeUrl(url)).toThrow(ValidationError)
    }
  })

  it('rejects private and link-local IPv4 ranges', () => {
    for (const url of [
      'http://10.0.0.5/x',
      'http://192.168.1.1/x',
      'http://172.16.0.1/x',
      'http://172.31.255.255/x',
      'http://169.254.169.254/x', // cloud metadata endpoint
    ]) {
      expect(() => assertSafeUrl(url)).toThrow(ValidationError)
    }
  })

  it('rejects internal-only hostnames', () => {
    expect(() => assertSafeUrl('http://db.internal/x')).toThrow(ValidationError)
    expect(() => assertSafeUrl('http://printer.local/x')).toThrow(
      ValidationError,
    )
  })

  it('allows public IPs that merely start with a private-looking octet', () => {
    // 172.15.x and 172.32.x are public (private block is 172.16–172.31 only)
    expect(assertSafeUrl('http://172.15.0.1/x').hostname).toBe('172.15.0.1')
    expect(assertSafeUrl('http://172.32.0.1/x').hostname).toBe('172.32.0.1')
  })

  it('throws on malformed URLs', () => {
    expect(() => assertSafeUrl('not a url')).toThrow(ValidationError)
    expect(() => assertSafeUrl('')).toThrow(ValidationError)
  })
})
