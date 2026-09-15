// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Link fetching for enrichment — the boundary where a user-supplied URL turns
 * into a server-side request, and its bytes into a model input. (Three-gate
 * rule: security.) `assertSafeUrl` itself is covered next door; this pins the
 * two things the fetcher adds on top of it: every redirect hop is re-checked,
 * and bodies are bounded whatever the server declared.
 *
 * Run: npx vitest run packages/core/src/lib/items/enrichment/fetch-source.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchSource } from './fetch-source'
import { MAX_ENRICHMENT_IMAGE_BYTES } from './limits'
import { ValidationError } from '@/lib/errors'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
])

function image(
  bytes: Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) {
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'image/png', ...headers },
  })
}

function redirect(location: string) {
  return new Response(null, { status: 302, headers: { location } })
}

describe('fetchSource', () => {
  it('returns the image a link points at', async () => {
    fetchMock.mockResolvedValueOnce(image(PNG_BYTES))

    await expect(
      fetchSource('https://cdn.example.com/photo.png'),
    ).resolves.toEqual({
      kind: 'image',
      image: {
        mediaType: 'image/png',
        data: Buffer.from(PNG_BYTES).toString('base64'),
      },
    })
  })

  it('extracts the text of a page', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        '<html><head><title>VF-2</title></head><body><h1>Haas VF-2</h1><script>x()</script></body></html>',
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      ),
    )

    const source = await fetchSource('https://example.com/vf-2')

    expect(source.kind).toBe('page')
    if (source.kind !== 'page') return
    expect(source.page.title).toBe('VF-2')
    expect(source.page.text).toContain('Haas VF-2')
    expect(source.page.text).not.toContain('x()')
  })

  it('refuses a link that is neither a page nor an image', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('%PDF-1.7', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      }),
    )

    await expect(
      fetchSource('https://example.com/spec.pdf'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects an image the server declares oversize', async () => {
    fetchMock.mockResolvedValueOnce(
      image(PNG_BYTES, {
        'content-length': String(MAX_ENRICHMENT_IMAGE_BYTES + 1),
      }),
    )

    await expect(
      fetchSource('https://example.com/big.png'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('rejects an image past the cap whatever the server declared', async () => {
    // No content-length at all: the bound has to come from reading the body.
    fetchMock.mockResolvedValueOnce(
      image(new Uint8Array(MAX_ENRICHMENT_IMAGE_BYTES + 1)),
    )

    await expect(
      fetchSource('https://example.com/huge.png'),
    ).rejects.toBeInstanceOf(ValidationError)
  })

  it('checks every redirect hop against the private-network rules', async () => {
    // A public host that bounces to the cloud metadata endpoint. With
    // `redirect: 'follow'` the runtime would have fetched it for us.
    fetchMock.mockResolvedValueOnce(
      redirect('http://169.254.169.254/latest/meta-data/'),
    )

    await expect(
      fetchSource('https://example.com/photo'),
    ).rejects.toBeInstanceOf(ValidationError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('follows a redirect to another public host', async () => {
    fetchMock
      .mockResolvedValueOnce(redirect('https://cdn.example.com/photo.png'))
      .mockResolvedValueOnce(image(PNG_BYTES))

    const source = await fetchSource('https://example.com/photo')

    expect(source.kind).toBe('image')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const secondTarget = fetchMock.mock.calls[1]?.[0] as URL
    expect(secondTarget.href).toBe('https://cdn.example.com/photo.png')
  })

  it('gives up on a redirect loop', async () => {
    fetchMock.mockResolvedValue(redirect('https://example.com/again'))

    await expect(
      fetchSource('https://example.com/loop'),
    ).rejects.toBeInstanceOf(ValidationError)
  })
})
