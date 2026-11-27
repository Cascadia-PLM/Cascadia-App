// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/**
 * A single-consumer channel for progress lines produced off the generator's
 * own call stack.
 *
 * The FreeCAD agent runs as a promise — several of them at once under the
 * part generator's concurrency pool — while the stage is an async generator
 * that can only yield when it has control. Without a channel, a part's
 * per-attempt progress ("attempt 2/6: NameError …") would be buffered until
 * that part finished, minutes later, which is the one moment it is no longer
 * interesting. Producers `push`; the generator races `wait()` against the
 * work it is waiting on and `drain()`s whatever arrived.
 *
 * One consumer at a time: a second `wait()` before the first resolved
 * replaces its wake-up, which is fine here because the pool loop is the only
 * reader. An orphaned wait promise simply never settles, and nothing holds
 * a reference to it.
 */
export interface ProgressChannel {
  /** Queue a line. Wakes a pending `wait()`. */
  push: (text: string) => void
  /** Resolves once at least one line is queued (immediately if some already are). */
  wait: () => Promise<void>
  /** Take every queued line, oldest first. */
  drain: () => Array<string>
}

export function createProgressChannel(): ProgressChannel {
  const queue: Array<string> = []
  let wake: (() => void) | null = null

  return {
    push(text) {
      queue.push(text)
      const resolve = wake
      wake = null
      resolve?.()
    },
    wait() {
      return new Promise<void>((resolve) => {
        if (queue.length > 0) {
          resolve()
          return
        }
        wake = resolve
      })
    },
    drain() {
      return queue.splice(0)
    },
  }
}
