// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ComponentType, ReactNode } from 'react'

/**
 * The client-side half of the approval seam.
 *
 * A module that participates in approval voting usually needs three things in
 * the dialog, not just one: somewhere to render, a say in whether submit is
 * allowed yet, and extra fields on the request. A plain render slot only gives
 * the first, which is why this exists alongside `slot-registry.tsx` rather than
 * reusing it.
 *
 * It mirrors the server-side `ApprovalRegistry` deliberately — `body` here is
 * what `buildExtras` consumes there, and `blocked` is the client's early
 * warning for the same condition `beforeVote` enforces authoritatively. The
 * client half is a courtesy to the user; the server half is the actual gate.
 *
 * Core ships zero contributions, so with nothing registered the dialog renders
 * and behaves exactly as it did before this seam existed.
 */

export interface ApprovalFormSlotProps {
  /** The dialog is open. Contributions can key lazy fetches off this. */
  open: boolean
  /** A submit is in flight; inputs should go read-only. */
  disabled: boolean
  /** What is being approved, e.g. "ECO-000123", for attestation wording. */
  subjectLabel: string | null
}

export interface ApprovalContribution {
  /** Block submit — a required input is missing or the action is impossible. */
  blocked: boolean
  /** Extra fields merged into the approval request body. */
  body: Record<string, unknown>
}

export type ApprovalFormComponent = ComponentType<ApprovalFormSlotProps>

const components: Array<ApprovalFormComponent> = []

/**
 * Contribute to the approval dialog. Called from a composition root at boot.
 *
 * Registration is read at render time, so anything registered after the dialog
 * first mounts will not appear until it remounts. Registering at boot — which
 * is the only supported time — makes that moot.
 */
export function registerApprovalFormSlot(
  component: ApprovalFormComponent,
): void {
  components.push(component)
}

/** Drop every contribution. Tests only. */
export function clearApprovalFormSlots(): void {
  components.length = 0
}

type ContributeFn = (id: string, value: ApprovalContribution | null) => void

const ContributionContext = createContext<ContributeFn | null>(null)

/**
 * Publish this contribution's state to the dialog hosting it.
 *
 * Call from a component registered with {@link registerApprovalFormSlot}. The
 * contribution is withdrawn automatically on unmount, so a dialog that closes
 * does not leave a stale block behind.
 *
 * `id` must be stable and unique per contribution — the package id is the
 * obvious choice.
 */
export function useApprovalContribution(
  id: string,
  contribution: ApprovalContribution,
): void {
  const contribute = useContext(ContributionContext)

  // Compared by value, not identity, so a contribution built inline each render
  // does not retrigger the effect. Sound here because `body` has to be
  // JSON-serializable anyway — it becomes a POST body.
  const serialized = JSON.stringify(contribution)

  useEffect(() => {
    if (!contribute) return
    contribute(id, JSON.parse(serialized) as ApprovalContribution)
    return () => {
      contribute(id, null)
    }
  }, [contribute, id, serialized])
}

/**
 * Render the registered contributions and collect what they report.
 *
 * Returns the nodes to place in the dialog, whether any contribution is
 * blocking submit, and the fields to merge into the request body.
 */
export function useApprovalFormSlots(props: ApprovalFormSlotProps): {
  slots: ReactNode
  blocked: boolean
  body: Record<string, unknown>
} {
  const [contributions, setContributions] = useState<
    Record<string, ApprovalContribution>
  >({})

  const contribute = useCallback<ContributeFn>((id, value) => {
    setContributions((prev) => {
      if (value === null) {
        if (!(id in prev)) return prev
        const next = { ...prev }
        delete next[id]
        return next
      }
      return { ...prev, [id]: value }
    })
  }, [])

  const { blocked, body } = useMemo(() => {
    const values = Object.values(contributions)
    return {
      blocked: values.some((c) => c.blocked),
      body: values.reduce<Record<string, unknown>>(
        (acc, c) => ({ ...acc, ...c.body }),
        {},
      ),
    }
  }, [contributions])

  const { open, disabled, subjectLabel } = props

  // Rendered as components, not called as functions, so each contribution owns
  // its own hook scope and may use `useQuery` and friends.
  const slots = useMemo(
    () =>
      components.length === 0 ? null : (
        <ContributionContext.Provider value={contribute}>
          {components.map((Component, index) => (
            <Fragment key={index}>
              <Component
                open={open}
                disabled={disabled}
                subjectLabel={subjectLabel}
              />
            </Fragment>
          ))}
        </ContributionContext.Provider>
      ),
    [contribute, open, disabled, subjectLabel],
  )

  return { slots, blocked, body }
}
