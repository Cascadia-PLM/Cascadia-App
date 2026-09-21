// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { EVERY_EVENT } from './types'
import type {
  ConsumedExtension,
  EveryEventConsumedExtension,
  Extension,
  ExtensionPhase,
  GuardExtension,
  InTransactionExtension,
  RegisteredExtension,
} from './types'
import type { GuardOperation } from './operations'
import { EventTypeRegistry } from '@/lib/events/registry'

/**
 * Declare an extension, and register it.
 *
 * One call, generic over the payload or intent type, discriminated on `phase`.
 * `on` takes the definition *object* — `ITEM_CREATED`, or `ITEM_CREATE` for a
 * guard — never its type string, which is what makes the type flow into both
 * `when` and the handler. Passing a string would type-check nothing, and a
 * layer whose one genuine differentiator is "the rule you wrote is the shape
 * the fact actually has" cannot afford that.
 *
 * Registration happens as a side effect, like `defineDomainEvent` and
 * `defineGuardOperation`: importing a module that declares extensions is
 * enough to have them. Core's own live under `lib/extensions/`; a module
 * package's are imported from its `register.server.ts`.
 *
 * **Why one overload per arm.** Three shapes were measured, and only this one
 * types everything it claims to:
 *
 * - A single generic call over a `phase`-discriminated union works right up
 *   until the wildcard `consumed` arm exists. That arm shares
 *   `phase: 'consumed'` with the typed one, so `phase` stops selecting a single
 *   constituent and `handler`'s parameter falls back to an implicit `any`.
 * - Two overloads — wildcard, then a union of the three typed arms — fix the
 *   handler but silently lose `when`. With a union in parameter position TS
 *   cannot pin `T` from `on`, falls back to the constraint
 *   `Record<string, unknown>`, and then accepts `when: { nosuchfield: … }` and
 *   `when: { itemType: 42 }` without complaint. The layer's one genuine
 *   differentiator, gone, with everything still compiling.
 * - One overload per arm, below. The parameter is a single non-union type, so
 *   `T` is inferred from `on` and `when` is checked against it.
 *
 * None of that was predictable from reading; `signature.inference.ts` fails if
 * any of it stops holding.
 */
export function defineExtension(
  extension: EveryEventConsumedExtension,
): EveryEventConsumedExtension
export function defineExtension<T extends Record<string, unknown>>(
  extension: GuardExtension<T>,
): GuardExtension<T>
export function defineExtension<T extends Record<string, unknown>>(
  extension: InTransactionExtension<T>,
): InTransactionExtension<T>
export function defineExtension<T extends Record<string, unknown>>(
  extension: ConsumedExtension<T>,
): ConsumedExtension<T>
export function defineExtension(extension: RegisteredExtension): Extension {
  ExtensionRegistry.register(extension)
  return extension
}

/** What `on` resolves to for display and indexing. */
function subjectOf(extension: RegisteredExtension): string {
  if (extension.phase === 'guard') return extension.on.operation
  if (extension.on === EVERY_EVENT) return EVERY_EVENT
  return extension.on.type
}

/**
 * Every extension this process can run, across all three phases.
 *
 * **One registry, not two.** The `consumed` phase registers *into* this rather
 * than beside a separate consumer registry, and that is not tidiness: two
 * registries would mean two duplicate policies, two cursor-creation paths, and
 * an introspection endpoint able to answer for only one of them — which is
 * precisely the fragmentation this layer exists to remove. `consumers()`
 * projects the `consumed` extensions into the shape the event-log runtime
 * already consumes, so there is one list of registrants and one place to ask
 * what will run.
 *
 * Durable state — a `consumed` extension's cursor — lives in
 * `event_consumers`, never in this map. Registration only says "this process
 * is willing to run these".
 *
 * Zero registrations costs zero queries and zero allocations on the write
 * path: the phase indexes are empty maps and every dispatch returns on a
 * `size === 0` check before it touches a database or builds a context. The
 * community edition must not pay for a feature it does not use.
 */
export class ExtensionRegistry {
  private static extensions = new Map<string, RegisteredExtension>()
  /** `phase → subject → extensions`, so a dispatch is two map reads. */
  private static byPhase = new Map<
    ExtensionPhase,
    Map<string, Array<RegisteredExtension>>
  >()

  static register(extension: RegisteredExtension): void {
    const existing = this.extensions.get(extension.id)
    // The identical object again is what a re-imported module produces: a
    // no-op. A different object under one id is a conflict — for a `consumed`
    // extension the two would share a durable cursor, and for any phase
    // whichever registered last would silently decide what runs. Same policy
    // as every other registry a module contributes to.
    if (existing === extension) return
    if (existing) {
      throw new Error(`Extension "${extension.id}" is already registered`)
    }

    this.validate(extension)
    this.extensions.set(extension.id, extension)

    const subject = subjectOf(extension)
    const forPhase =
      this.byPhase.get(extension.phase) ??
      new Map<string, Array<RegisteredExtension>>()
    forPhase.set(subject, [...(forPhase.get(subject) ?? []), extension])
    this.byPhase.set(extension.phase, forPhase)
  }

  /**
   * Refuse a registration that cannot ever fire, at registration time.
   *
   * The consumer registry this replaces validated only id collision, and
   * matched types with a plain string `includes`. So a subscription naming a
   * type that had been renamed did not fail — it advanced its cursor past
   * every event forever and reported itself idle. Checking `on` against the
   * catalog here is what turns the stage-0 rename, and every rename after it,
   * into a loud failure rather than a silent one, and it is the cheapest of
   * this layer's guarantees.
   *
   * Guards need no equivalent check: `on` must *be* one of the five exported
   * operation objects, so the compiler has already refused the typo.
   */
  private static validate(extension: RegisteredExtension): void {
    if (extension.phase === 'guard') return
    if (extension.on === EVERY_EVENT) return
    if (!EventTypeRegistry.hasType(extension.on.type)) {
      throw new Error(
        `Extension "${extension.id}" subscribes to unknown event type ` +
          `"${extension.on.type}". Register the definition with ` +
          `defineDomainEvent() before the extension that consumes it — an ` +
          `unknown type would never match, and the extension would report ` +
          `itself idle forever.`,
      )
    }
  }

  /**
   * The extensions registered for one phase and subject, in registration
   * order. Empty array when there are none — the common case, and the one the
   * write path is optimised for.
   */
  static forSubject(
    phase: ExtensionPhase,
    subject: string,
  ): ReadonlyArray<RegisteredExtension> {
    const forPhase = this.byPhase.get(phase)
    if (!forPhase) return []
    if (phase !== 'consumed') return forPhase.get(subject) ?? []
    // A `consumed` wildcard extension is registered under '*' and matches
    // every subject, so it has to be unioned in.
    const exact = forPhase.get(subject) ?? []
    const wildcard = forPhase.get(EVERY_EVENT) ?? []
    if (wildcard.length === 0) return exact
    return [...exact, ...wildcard]
  }

  /** Whether any extension at all is registered for a phase. */
  static hasPhase(phase: ExtensionPhase): boolean {
    const forPhase = this.byPhase.get(phase)
    return forPhase !== undefined && forPhase.size > 0
  }

  static get(id: string): RegisteredExtension | undefined {
    return this.extensions.get(id)
  }

  /** Every registered extension, sorted by id for stable output. */
  static list(): Array<RegisteredExtension> {
    return [...this.extensions.values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    )
  }

  /** Every `consumed` extension, which is what the poller drains. */
  static consumed(): Array<ConsumedExtension | EveryEventConsumedExtension> {
    return this.list().filter(
      (e): e is ConsumedExtension | EveryEventConsumedExtension =>
        e.phase === 'consumed',
    )
  }

  /** Drop every extension. Tests only. */
  static clear(): void {
    this.extensions.clear()
    this.byPhase.clear()
  }
}

/** Narrowing helpers, so the dispatcher does not repeat the phase check. */
export function isGuardExtension(
  extension: RegisteredExtension,
): extension is GuardExtension {
  return extension.phase === 'guard'
}

export function isInTransactionExtension(
  extension: RegisteredExtension,
): extension is InTransactionExtension {
  return extension.phase === 'in-transaction'
}

/** What `on` names, for introspection output. */
export function extensionSubject(extension: RegisteredExtension): string {
  return subjectOf(extension)
}

/** The operation a guard extension attaches to, for introspection. */
export function guardOperationOf(
  extension: RegisteredExtension,
): GuardOperation | null {
  return extension.phase === 'guard' ? extension.on : null
}
