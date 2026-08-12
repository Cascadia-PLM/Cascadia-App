// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * Approval form registry tests.
 *
 * This registry is the client half of the approval seam, and the mechanism
 * every later UI seam is meant to copy. What makes it worth testing is not the
 * rendering but the reporting: contributions publish `blocked` and `body`
 * upward through an effect, and withdraw on unmount. Get that wrong in either
 * direction and the failure is silent — either a dialog that can never submit,
 * or one that submits without the fields a module meant to attach.
 *
 * The invariants, stated as the dialog experiences them:
 *
 * - No contributions → nothing rendered, nothing blocked, no extra fields.
 * - Any contribution blocking → submit blocked.
 * - Every contribution's fields reach the request body.
 * - A contribution that unmounts stops blocking and stops contributing.
 *
 * Run: npm run test -- src/lib/workflows/approval-form-registry.test.tsx
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import {
  clearApprovalFormSlots,
  registerApprovalFormSlot,
  useApprovalContribution,
  useApprovalFormSlots,
} from './approval-form-registry'
import type { ApprovalFormSlotProps } from './approval-form-registry'

/** Renders the registry the way `ApprovalDialog` does, and shows what it got. */
function Host({ open = true, disabled = false, subjectLabel = null } = {}) {
  const { slots, blocked, body } = useApprovalFormSlots({
    open,
    disabled,
    subjectLabel,
  })
  return (
    <div>
      <div data-testid="blocked">{String(blocked)}</div>
      <div data-testid="body">{JSON.stringify(body)}</div>
      {slots}
    </div>
  )
}

afterEach(() => {
  clearApprovalFormSlots()
})

describe('useApprovalFormSlots', () => {
  it('renders nothing and blocks nothing when no module is registered', () => {
    render(<Host />)

    expect(screen.getByTestId('blocked')).toHaveTextContent('false')
    expect(screen.getByTestId('body')).toHaveTextContent('{}')
  })

  it('lets a contribution block submit and add request fields', async () => {
    registerApprovalFormSlot(function Signing() {
      useApprovalContribution('test', {
        blocked: true,
        body: { password: 'hunter2' },
      })
      return <div>signing block</div>
    })

    render(<Host />)

    expect(screen.getByText('signing block')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('blocked')).toHaveTextContent('true')
    })
    expect(screen.getByTestId('body')).toHaveTextContent(
      '{"password":"hunter2"}',
    )
  })

  it('merges fields from every contribution and blocks if any one blocks', async () => {
    registerApprovalFormSlot(function Open() {
      useApprovalContribution('open', { blocked: false, body: { a: 1 } })
      return null
    })
    registerApprovalFormSlot(function Blocking() {
      useApprovalContribution('blocking', { blocked: true, body: { b: 2 } })
      return null
    })

    render(<Host />)

    await waitFor(() => {
      expect(screen.getByTestId('blocked')).toHaveTextContent('true')
    })
    // Parsed rather than string-matched: the merge must contain both fields,
    // and key order is not something this registry promises.
    const body = JSON.parse(screen.getByTestId('body').textContent) as Record<
      string,
      unknown
    >
    expect(body).toEqual({ a: 1, b: 2 })
  })

  it('tracks a contribution as its own state changes', async () => {
    registerApprovalFormSlot(function Typing() {
      const [value, setValue] = useState('')
      useApprovalContribution('typing', {
        blocked: value.length === 0,
        body: value ? { password: value } : {},
      })
      return <button onClick={() => setValue('typed')}>fill</button>
    })

    render(<Host />)

    // Empty input blocks submit...
    await waitFor(() => {
      expect(screen.getByTestId('blocked')).toHaveTextContent('true')
    })

    fireEvent.click(screen.getByText('fill'))

    // ...and filling it in releases the block and contributes the field.
    await waitFor(() => {
      expect(screen.getByTestId('blocked')).toHaveTextContent('false')
    })
    expect(screen.getByTestId('body')).toHaveTextContent('{"password":"typed"}')
  })

  it('withdraws a contribution when it unmounts', async () => {
    registerApprovalFormSlot(function Conditional({
      open,
    }: ApprovalFormSlotProps) {
      // Mirrors a dialog closing: the contribution goes away, and with it any
      // block it was holding. A stale block would leave submit dead forever.
      return open ? <Blocker /> : null
    })

    function Blocker() {
      useApprovalContribution('blocker', { blocked: true, body: { x: 1 } })
      return null
    }

    const { rerender } = render(<Host open={true} />)

    await waitFor(() => {
      expect(screen.getByTestId('blocked')).toHaveTextContent('true')
    })

    rerender(<Host open={false} />)

    await waitFor(() => {
      expect(screen.getByTestId('blocked')).toHaveTextContent('false')
    })
    expect(screen.getByTestId('body')).toHaveTextContent('{}')
  })
})
