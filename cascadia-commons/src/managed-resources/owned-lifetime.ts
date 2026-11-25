// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import type {
  CleanupReport,
  Finalizer,
  LifetimeOwner,
  ResourceLifetime,
  SetupOutcome,
} from './lifetime'

/** The owner alone can end the lifetime; adapters can acquire and observe it. */
export function createOwnedLifetime(
  onError: (error: unknown) => void,
  parent?: ResourceLifetime,
): LifetimeOwner {
  return parent ? parent.child(onError) : buildOwnedLifetime(onError)
}

function buildOwnedLifetime(
  onError: (error: unknown) => void,
  parentIsLive?: () => boolean,
  registerWithParent?: (dispose: () => Promise<CleanupReport>) => () => void,
): LifetimeOwner {
  const registration = createRegistration(onError, parentIsLive)
  let unlink: () => void = () => undefined
  const owner: LifetimeOwner = {
    context: registration.lifetime,
    run<T>(
      setup: (context: ResourceLifetime) => T | PromiseLike<T>,
      publish: (value: T) => void = () => undefined,
      onFailure = onError,
    ) {
      const report = (error: unknown): SetupOutcome<T> => {
        if (!registration.isLive()) return { kind: 'expired' }
        void owner.dispose()
        try {
          onFailure(error)
        } catch {
          // A diagnostic cannot produce an unhandled rejection.
        }
        return { kind: 'failed', error }
      }
      if (!registration.isLive()) return Promise.resolve({ kind: 'expired' })
      try {
        return Promise.resolve(setup(registration.lifetime)).then(
          (value): SetupOutcome<T> => {
            if (!registration.isLive()) return { kind: 'expired' }
            try {
              publish(value)
              return registration.isLive()
                ? { kind: 'ready', value }
                : { kind: 'expired' }
            } catch (error) {
              return report(error)
            }
          },
          report,
        )
      } catch (error) {
        return Promise.resolve(report(error))
      }
    },
    dispose() {
      unlink()
      registration.expire()
      return registration.finalize()
    },
  }
  if (registerWithParent) unlink = registerWithParent(owner.dispose)
  return Object.freeze(owner)
}

function createRegistration(
  onCleanupError: (error: unknown) => void,
  parentIsLive?: () => boolean,
) {
  let live = true
  let disposal: Promise<CleanupReport> | undefined
  const controller = new AbortController()
  const finalizers = new Set<Finalizer>()
  const pendingCleanup: Array<Promise<void>> = []
  let cleanupSettled = false
  const errors: Array<unknown> = []
  const isLive = () => live && (parentIsLive?.() ?? true)

  const reportError = (error: unknown) => {
    errors.push(error)
    try {
      onCleanupError(error)
    } catch {
      // Preserve the cleanup failure even if diagnostics fail.
    }
  }
  const runFinalizer = (finalizer: Finalizer): Promise<void> => {
    try {
      return Promise.resolve(finalizer()).catch(reportError)
    } catch (error) {
      reportError(error)
      return Promise.resolve()
    }
  }
  const register = (finalizer: Finalizer) => {
    if (isLive()) {
      finalizers.add(finalizer)
      return () => {
        finalizers.delete(finalizer)
      }
    } else {
      const cleanup = runFinalizer(finalizer)
      if (!cleanupSettled) pendingCleanup.push(cleanup)
    }
    return () => undefined
  }
  const own = <T>(
    resource: T,
    release: (resource: T) => void | Promise<void>,
  ) => {
    register(() => release(resource))
    if (!isLive()) throw new Error('Resource lifetime ended during acquisition')
    return resource
  }
  const acquire: ResourceLifetime['acquire'] = <T>(
    create: (signal: AbortSignal) => T,
    release: (resource: Awaited<T>) => void | Promise<void>,
  ) => {
    if (!isLive())
      throw new Error('Cannot acquire into an ended resource lifetime')
    const acquired = create(controller.signal)
    const registered = isPromiseLike(acquired)
      ? Promise.resolve(acquired).then((resource) => own(resource, release))
      : own(acquired as Awaited<T>, release)
    // Factory inference determines sync/async return shape; erasure stays here.
    return registered as T extends PromiseLike<unknown>
      ? Promise<Awaited<T>>
      : T
  }

  return {
    lifetime: Object.freeze<ResourceLifetime>({
      signal: controller.signal,
      onDispose: (finalizer) => {
        register(finalizer)
      },
      child: (onError) =>
        buildOwnedLifetime(onError, isLive, (dispose) =>
          register(async () => {
            const report = await dispose()
            errors.push(...report.errors)
          }),
        ),
      acquire,
      adopt: own,
      guard(callback) {
        return (...args) => (isLive() ? callback(...args) : undefined)
      },
    }),
    isLive,
    expire() {
      live = false
    },
    finalize() {
      if (disposal) return disposal
      let settled: (report: CleanupReport) => void = () => undefined
      disposal = new Promise((resolve) => {
        settled = resolve
      })
      controller.abort()
      pendingCleanup.push(...[...finalizers].reverse().map(runFinalizer))
      finalizers.clear()
      void Promise.resolve().then(async () => {
        while (pendingCleanup.length > 0) {
          await Promise.all(pendingCleanup.splice(0))
        }
        cleanupSettled = true
        settled({ errors: [...errors] })
      })
      return disposal
    },
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    ((typeof value === 'object' && value !== null) ||
      typeof value === 'function') &&
    'then' in value &&
    typeof value.then === 'function'
  )
}
