// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Cascadia PLM LLC

/** How long shutdown waits for work in flight before exiting regardless. */
const DRAIN_TIMEOUT_MS = 10_000

/**
 * Stop an app server cleanly on SIGTERM or SIGINT.
 *
 * Without this the process simply died on a signal. That was never unsafe for
 * the event log — a consumer run cut off mid-batch rolls back and its events are
 * redelivered — but the entry points discarded the poller's stop function, so a
 * run in flight was abandoned rather than allowed to finish, and every restart
 * could redeliver a batch it need not have. Now polling stops first and its run
 * in flight is given the drain window to commit, the HTTP server stops
 * accepting connections, and the process exits once both are done or the
 * window closes.
 */
export function installGracefulShutdown(options: {
  server: { close: (callback?: (error?: Error) => void) => unknown }
  stopEventConsumers: (() => Promise<void>) | null
}): void {
  let shuttingDown = false

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(
      `${signal} received: stopping event consumers and closing the server`,
    )

    const closed = new Promise<void>((resolve) => {
      options.server.close(() => resolve())
    })
    const drained = Promise.all([options.stopEventConsumers?.(), closed])
    const deadline = new Promise<void>((resolve) => {
      setTimeout(resolve, DRAIN_TIMEOUT_MS).unref()
    })

    void Promise.race([drained, deadline]).finally(() => process.exit(0))
  }

  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}
