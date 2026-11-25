// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

export type Finalizer = () => void | Promise<void>
export interface CleanupReport {
  readonly errors: ReadonlyArray<unknown>
}
export type SetupOutcome<T> =
  | { kind: 'ready'; value: T }
  | { kind: 'expired' }
  | { kind: 'failed'; error: unknown }

/** Adapter authority: acquire, register partial cleanup, and guard callbacks. */
export interface ResourceLifetime {
  readonly signal: AbortSignal
  readonly acquire: <T>(
    create: (signal: AbortSignal) => T,
    release: (resource: NoInfer<Awaited<T>>) => void | Promise<void>,
  ) => T extends PromiseLike<unknown> ? Promise<Awaited<T>> : T
  /** Transfer an already-created synchronous resource; prior effects cannot be cancelled. */
  readonly adopt: <T>(
    resource: T & (NoInfer<T> extends PromiseLike<unknown> ? never : unknown),
    release: (resource: NoInfer<T>) => void | Promise<void>,
  ) => T
  readonly onDispose: (finalizer: Finalizer) => void
  readonly guard: <TArgs extends Array<unknown>, TResult>(
    callback: (...args: TArgs) => TResult,
  ) => (...args: TArgs) => TResult | undefined
  /** A child can release itself, but never its parent or a sibling. */
  readonly child: (onError: (error: unknown) => void) => LifetimeOwner
}

/** Release authority stays with the owner; adapters receive only `context`. */
export interface LifetimeOwner {
  readonly context: ResourceLifetime
  readonly run: <T>(
    setup: (context: ResourceLifetime) => T | PromiseLike<T>,
    publish?: (value: T) => void,
    onFailure?: (error: unknown) => void,
  ) => Promise<SetupOutcome<T>>
  readonly dispose: () => Promise<CleanupReport>
}
