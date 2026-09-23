# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Backoff arithmetic in `_retry_delay_seconds`.

Two implementations of one rule read the same `jobs.retry_delays` column —
`JobService.markFailed` in TypeScript and this one in Python — so the arithmetic
has to agree across a language boundary that no compiler checks. The TS side is
covered by JobService.test.ts; this is the other half.

No database: these are properties of the function, and they run everywhere.
"""

from __future__ import annotations

from cascadia_worker_common.db import RETRY_DELAYS_MS, _retry_delay_seconds


def test_first_failure_waits_the_schedules_first_entry() -> None:
    """attempts is counted at claim time, so the first failure arrives as 1.

    Off-by-one here is invisible in production — the job still retries, just on
    the wrong rung of the ladder — which is exactly why it is asserted.
    """
    assert _retry_delay_seconds(1, [5000, 60000, 120000]) == 5.0


def test_the_rows_own_schedule_beats_the_fallback() -> None:
    schedule = [1000, 2000, 3000]
    assert _retry_delay_seconds(2, schedule) == 2.0
    # …and is genuinely the row's, not the module constant that happens to
    # have the same shape.
    assert _retry_delay_seconds(2, schedule) != RETRY_DELAYS_MS[1] / 1000.0


def test_attempts_past_the_end_clamp_to_the_last_entry() -> None:
    """A job may be retried more times than its schedule has rungs.

    max_attempts and the length of retry_delays are independent values; the
    long-tail attempt must park at the longest delay, not raise IndexError and
    strand the row in 'running'.
    """
    schedule = [1000, 2000, 3000]
    assert _retry_delay_seconds(4, schedule) == 3.0
    assert _retry_delay_seconds(99, schedule) == 3.0


def test_attempts_below_one_clamp_to_the_first_entry() -> None:
    """Negative indexing would silently read the schedule backwards."""
    schedule = [1000, 2000, 3000]
    assert _retry_delay_seconds(0, schedule) == 1.0
    assert _retry_delay_seconds(-3, schedule) == 1.0


def test_absent_and_empty_schedules_both_fall_back() -> None:
    """None is a pre-migration row; [] is a type declaring `retryDelays: []`.

    Both must reach the module fallback. An empty list that took the `if
    retry_delays` branch would index into nothing.
    """
    for attempts, expected in enumerate(RETRY_DELAYS_MS, start=1):
        assert _retry_delay_seconds(attempts, None) == expected / 1000.0
        assert _retry_delay_seconds(attempts, []) == expected / 1000.0


def test_the_schedule_is_milliseconds_and_the_return_is_seconds() -> None:
    """The one unit conversion in the module, and the one place to get it wrong.

    `jobs.retry_delays`, RETRY_DELAYS_MS and the TS JobTypeConfig are all
    milliseconds; the caller feeds this straight into make_interval(secs => …).
    A factor of 1000 either way turns a 30-second backoff into 8 hours or 30ms.
    """
    assert _retry_delay_seconds(1, [30000]) == 30.0
    assert _retry_delay_seconds(1, [1]) == 0.001
