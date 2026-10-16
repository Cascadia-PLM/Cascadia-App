// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createOwnedLifetime } from './index'

describe('owned lifetime boundaries', () => {
  it('releases an uncooperative acquisition that finishes after disposal', async () => {
    let resolve!: (value: string) => void
    const pending = new Promise<string>((accept) => {
      resolve = accept
    })
    const release = vi.fn()
    const publish = vi.fn()
    const owner = createOwnedLifetime(vi.fn())
    const completion = owner.run(
      (lifetime) => lifetime.acquire(() => pending, release),
      publish,
    )
    const closing = owner.dispose()
    expect(owner.dispose()).toBe(closing)
    await closing
    resolve('late')
    await pending
    expect(await completion).toEqual({ kind: 'expired' })
    expect(release).toHaveBeenCalledExactlyOnceWith('late')
    expect(publish).not.toHaveBeenCalled()
  })

  it('cleans up partial setup in reverse order despite throwing cleanup and diagnostics', async () => {
    const released: Array<number> = []
    const failure = new Error('setup failed')
    const cleanupFailure = new Error('cleanup failed')
    const onFailure = vi.fn()
    const owner = createOwnedLifetime(() => {
      throw new Error('diagnostics failed')
    })
    void owner.run(
      (lifetime) => {
        lifetime.acquire(
          () => 1,
          (value) => {
            released.push(value)
          },
        )
        lifetime.acquire(
          () => 2,
          (value) => {
            released.push(value)
            throw cleanupFailure
          },
        )
        throw failure
      },
      vi.fn(),
      onFailure,
    )
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(failure)
    expect(await owner.dispose()).toEqual({ errors: [cleanupFailure] })
    expect(released).toEqual([2, 1])
  })

  it('expires the entire child tree before cleanup can reenter a sibling', async () => {
    const parent = createOwnedLifetime(vi.fn())
    const first = parent.context.child(vi.fn())
    const second = parent.context.child(vi.fn())
    const grandchild = first.context.child(vi.fn())
    const called = vi.fn()
    const retained = grandchild.context.guard(called)
    const cleanupFailure = new Error('child cleanup failed')
    second.context.onDispose(() => {
      retained()
      throw cleanupFailure
    })
    expect(await parent.dispose()).toEqual({ errors: [cleanupFailure] })
    expect(called).not.toHaveBeenCalled()
    expect(grandchild.context.signal.aborted).toBe(true)
  })

  it('rejects new acquisition before its factory runs after the owner ends', async () => {
    const owner = createOwnedLifetime(vi.fn())
    await owner.dispose()
    const create = vi.fn()
    expect(() => owner.context.acquire(create, vi.fn())).toThrow(
      'ended resource lifetime',
    )
    expect(create).not.toHaveBeenCalled()
    const release = vi.fn()
    expect(() => owner.context.adopt('external', release)).toThrow(
      'ended during acquisition',
    )
    expect(release).toHaveBeenCalledExactlyOnceWith('external')
  })

  it('owns non-native PromiseLike values without treating them as synchronous resources', async () => {
    const owner = createOwnedLifetime(vi.fn())
    const release = vi.fn()
    const native = Promise.resolve(7)
    const foreign: PromiseLike<number> = { then: native.then.bind(native) }
    expect(await owner.context.acquire(() => foreign, release)).toBe(7)
    await owner.dispose()
    expect(release).toHaveBeenCalledExactlyOnceWith(7)
  })

  // Compile-only acquisition contracts: no manual annotations or widened disposer input.
  void (() => {
    const owner = createOwnedLifetime(vi.fn())
    const sync = owner.context.acquire(
      () => 3,
      (_value) => undefined,
    )
    const async = owner.context.acquire(
      () => Promise.resolve('value'),
      (_value) => undefined,
    )
    expectTypeOf(sync).toEqualTypeOf<number>()
    expectTypeOf(async).toEqualTypeOf<Promise<string>>()
    owner.context.acquire(
      () => 3,
      // @ts-expect-error The resource factory determines the disposer argument.
      (_value: string) => undefined,
    )
    // @ts-expect-error An adapter context cannot dispose its owner.
    owner.context.dispose()
    owner.context.adopt(
      // @ts-expect-error Pending acquisition must use acquire, not synchronous adoption.
      Promise.resolve(3),
      () => undefined,
    )
  })
})
