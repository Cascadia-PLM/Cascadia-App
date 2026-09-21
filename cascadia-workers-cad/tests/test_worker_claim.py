# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""How ``_run_job`` settles a delivery.

A RabbitMQ delivery is a job's only copy, so the settlement is what decides
whether the job survives. These tests pin the four outcomes: an unparseable
body is dead-lettered, a claim that could not be attempted is requeued, a
claim that came back empty is acked without executing, and anything that
reached the database is acked exactly once.

The timeout watchdog rides the same seam and is covered here too: it may only
be armed once the claim has succeeded, and it must be called off however the
job ends. Its own two-stage behaviour belongs to
``workers/py-common/tests/test_watchdog.py``; what this file pins is the
wiring, which has to stay identical in both workers.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from types import ModuleType
from typing import Any, Callable, Optional
from unittest.mock import MagicMock

import pytest

# Nothing below touches geometry — this file is about which AMQP settlement a
# delivery gets — but importing the worker module drags in everything it
# consumes at import time: pythonocc-core through .converter and .assembly,
# plus pika and psycopg. Stub ONLY what is genuinely absent. In the conda
# environment the rest of this suite needs, every real package still wins and
# this preamble does nothing; without one, `pip install pytest pydantic
# pydantic-settings` is enough to run this file.


class _StubModule(ModuleType):
    """A module that answers any attribute with a fresh MagicMock."""

    def __getattr__(self, name: str) -> Any:
        return MagicMock(name=f"{self.__name__}.{name}")


class _StubLoader:
    def is_package(self, fullname: str) -> bool:
        # Every stub is a package, so `from OCC.Core.TopoDS import X` resolves
        # at any depth without this file enumerating the real module tree.
        return True

    def create_module(self, spec: Any) -> ModuleType:
        return _StubModule(spec.name)

    def exec_module(self, module: ModuleType) -> None:
        pass


class _StubFinder:
    """Answers for one absent top-level package and everything beneath it."""

    def __init__(self, root: str) -> None:
        self._root = root
        self._prefix = f"{root}."

    def find_spec(
        self, fullname: str, path: Any = None, target: Any = None
    ) -> Any:
        if fullname != self._root and not fullname.startswith(self._prefix):
            return None
        return importlib.util.spec_from_loader(fullname, _StubLoader())


def _stub_if_absent(*roots: str) -> None:
    for root in roots:
        if importlib.util.find_spec(root) is None:
            # Appended, never inserted: the real finders keep priority, so an
            # installed package is never shadowed by a stub.
            sys.meta_path.append(_StubFinder(root))


_stub_if_absent("OCC", "numpy", "pika", "psycopg")

from cad_converter import worker  # noqa: E402 — must follow the stubs above
from cad_converter.models import (  # noqa: E402
    CadConversionResult,
    JobRecord,
)

DELIVERY_TAG = 7
JOB_ID = "11111111-1111-4111-8111-111111111111"

VALID_BODY = json.dumps(
    {
        "jobId": JOB_ID,
        "type": "conversion.cad.step",
        "priority": 5,
        "attemptNumber": 1,
    }
).encode()

CLAIMED_JOB = JobRecord(
    id=JOB_ID,
    type="conversion.cad.step",
    status="running",
    payload={
        "vaultFileId": "22222222-2222-4222-8222-222222222222",
        "itemId": "33333333-3333-4333-8333-333333333333",
        "userId": "44444444-4444-4444-8444-444444444444",
    },
)


class FakeChannel:
    """Records settlements instead of speaking AMQP."""

    def __init__(self) -> None:
        self.is_open = True
        self.acks: list[int] = []
        self.nacks: list[tuple[int, bool]] = []

    def basic_ack(self, delivery_tag: int) -> None:
        self.acks.append(delivery_tag)

    def basic_nack(self, delivery_tag: int, requeue: bool) -> None:
        self.nacks.append((delivery_tag, requeue))


class FakeConnection:
    """Runs scheduled callbacks inline.

    ``add_callback_threadsafe`` exists to move a settlement onto pika's I/O
    thread, and by the time ``_run_job`` schedules one the outcome is already
    decided — so running it immediately loses no coverage and keeps these
    assertions synchronous.
    """

    is_open = True

    def add_callback_threadsafe(self, callback: Callable[[], None]) -> None:
        callback()


class StartedWatchdog:
    """What the fake ``start_job_watchdog`` hands back, and what it was told."""

    def __init__(self, kwargs: dict[str, Any]) -> None:
        self.kwargs = kwargs
        self.cancels = 0

    def cancel(self) -> None:
        self.cancels += 1


class Harness:
    """One delivery's worth of fakes, plus what the worker attempted."""

    def __init__(self, channel: FakeChannel) -> None:
        self.channel = channel
        self.claims: list[str] = []
        self.failures: list[tuple[str, str]] = []
        self.executions: list[str] = []
        self.watchdogs: list[StartedWatchdog] = []

    def deliver(self, body: bytes) -> None:
        # _process_message takes the slot that _run_job's `finally` releases;
        # take it here too so the module-level semaphore stays balanced.
        worker._worker_slots.acquire()
        worker._run_job(self.channel, DELIVERY_TAG, body)


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> Harness:
    """Wire the fakes into the worker module.

    Every database call is replaced: this file is about settlement, and a
    real call would need a database. ``claim_job`` is deliberately left
    raising, so a test that forgets to declare the claim it wants fails
    loudly instead of silently exercising the wrong phase.
    """
    h = Harness(FakeChannel())

    monkeypatch.setattr(worker, "_connection", FakeConnection())
    monkeypatch.setattr(worker, "add_job_log", lambda *a, **k: None)
    monkeypatch.setattr(worker, "mark_job_completed", lambda *a, **k: None)
    monkeypatch.setattr(
        worker,
        "mark_job_failed",
        lambda job_id, error: h.failures.append((job_id, error)),
    )
    monkeypatch.setattr(
        worker,
        "claim_job",
        lambda job_id: pytest.fail("claim_job was not stubbed by this test"),
    )
    # Zero, not the five-second default: the pause is churn control for a real
    # outage and would only slow the suite down.
    monkeypatch.setattr(worker.settings, "claim_retry_delay_seconds", 0)

    # A real watchdog would arm a ten-minute timer per delivery and, if a test
    # ever forgot to let the `finally` run, could take the pytest process down
    # with it. The fake records what it was asked for instead.
    def _start_watchdog(**kwargs: Any) -> StartedWatchdog:
        started = StartedWatchdog(kwargs)
        h.watchdogs.append(started)
        return started

    monkeypatch.setattr(worker, "start_job_watchdog", _start_watchdog)
    return h


def _claim(
    h: Harness,
    *,
    returns: Optional[JobRecord] = None,
    raises: Optional[Exception] = None,
) -> Callable[[str], Optional[JobRecord]]:
    """A ``claim_job`` stand-in that records the call, then returns or raises."""

    def _claim_job(job_id: str) -> Optional[JobRecord]:
        h.claims.append(job_id)
        if raises is not None:
            raise raises
        return returns

    return _claim_job


def _conversion(
    h: Harness, *, raises: Optional[Exception] = None
) -> Callable[..., CadConversionResult]:
    """An ``_execute_conversion`` stand-in that records the call."""

    def _execute(job_id: str, payload: Any) -> CadConversionResult:
        h.executions.append(job_id)
        if raises is not None:
            raise raises
        return CadConversionResult(
            outputFileIds=["55555555-5555-4555-8555-555555555555"],
            totalParts=1,
            polygonCount=12,
            conversionTimeMs=5,
        )

    return _execute


def test_claim_failure_requeues_the_delivery(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A claim that never landed must not consume the job's only copy."""
    monkeypatch.setattr(
        worker,
        "claim_job",
        _claim(harness, raises=RuntimeError("connection to the database failed")),
    )

    harness.deliver(VALID_BODY)

    assert harness.claims == [JOB_ID]
    assert harness.channel.nacks == [(DELIVERY_TAG, True)]
    assert harness.channel.acks == []
    # The row is still 'queued', where mark_job_failed is guarded to 'running'
    # and no-ops — calling it would only make the failure look recorded.
    assert harness.failures == []


def test_unclaimable_job_acks_without_executing(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A None claim means somebody else owns the outcome: ack and stop."""
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=None))
    monkeypatch.setattr(worker, "_execute_conversion", _conversion(harness))

    harness.deliver(VALID_BODY)

    assert harness.channel.acks == [DELIVERY_TAG]
    assert harness.channel.nacks == []
    assert harness.executions == []


def test_unparseable_body_is_dead_lettered(harness: Harness) -> None:
    """A body no retry can fix goes to the DLQ, and touches no database."""
    harness.deliver(b"{ not json")

    assert harness.channel.nacks == [(DELIVERY_TAG, False)]
    assert harness.channel.acks == []
    assert harness.claims == []
    assert harness.failures == []


def test_body_that_is_not_a_job_message_is_dead_lettered(
    harness: Harness,
) -> None:
    """Well-formed JSON missing the message fields is poison too."""
    harness.deliver(json.dumps({"jobId": JOB_ID}).encode())

    assert harness.channel.nacks == [(DELIVERY_TAG, False)]
    assert harness.channel.acks == []
    assert harness.claims == []
    assert harness.failures == []


def test_successful_conversion_acks_exactly_once(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One settlement, and it is an ack.

    A second ack on the same tag makes the broker close the channel with 406
    PRECONDITION_FAILED, which tears the consumer down and reconnects.
    """
    monkeypatch.setattr(
        worker, "claim_job", _claim(harness, returns=CLAIMED_JOB)
    )
    monkeypatch.setattr(worker, "_execute_conversion", _conversion(harness))

    harness.deliver(VALID_BODY)

    assert harness.executions == [JOB_ID]
    assert harness.channel.acks == [DELIVERY_TAG]
    assert harness.channel.nacks == []


def test_failed_conversion_records_the_failure_and_acks(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Past the claim, retries are scheduled by status — so a failure acks."""
    monkeypatch.setattr(
        worker, "claim_job", _claim(harness, returns=CLAIMED_JOB)
    )
    monkeypatch.setattr(
        worker,
        "_execute_conversion",
        _conversion(harness, raises=ValueError("bad geometry")),
    )

    harness.deliver(VALID_BODY)

    assert [job_id for job_id, _ in harness.failures] == [JOB_ID]
    assert harness.channel.acks == [DELIVERY_TAG]
    assert harness.channel.nacks == []


def test_a_claimed_job_is_watched_on_its_configured_timeout(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`job_timeout` was a setting nothing read until the watchdog existed.

    The arguments matter as much as the call: a watchdog handed the wrong
    liveness probe would decide whether to kill the process by asking about
    some other thread.
    """
    monkeypatch.setattr(
        worker, "claim_job", _claim(harness, returns=CLAIMED_JOB)
    )
    monkeypatch.setattr(worker, "_execute_conversion", _conversion(harness))

    harness.deliver(VALID_BODY)

    assert len(harness.watchdogs) == 1
    started = harness.watchdogs[0]
    assert started.kwargs["job_id"] == JOB_ID
    assert started.kwargs["timeout_ms"] == worker.settings.job_timeout
    assert (
        started.kwargs["poison_grace_ms"]
        == worker.settings.poison_exit_grace_ms
    )
    # The probe is bound to the thread that ran the job — this one, here.
    assert started.kwargs["job_thread_alive"]() is True
    assert started.cancels == 1


def test_a_failed_job_still_calls_off_its_watchdog(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cancel lives in `finally` for this case, not the happy one.

    A job that raised is over; leaving its watchdog armed would fail an
    already-settled row and then exit the process over a thread that is on its
    way out.
    """
    monkeypatch.setattr(
        worker, "claim_job", _claim(harness, returns=CLAIMED_JOB)
    )
    monkeypatch.setattr(
        worker,
        "_execute_conversion",
        _conversion(harness, raises=ValueError("bad geometry")),
    )

    harness.deliver(VALID_BODY)

    assert [w.cancels for w in harness.watchdogs] == [1]


def test_a_delivery_that_claims_nothing_is_never_watched(
    harness: Harness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No claim, no deadline: the row belongs to somebody else.

    Arming here would have this worker fail a job another one is running.
    """
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=None))

    harness.deliver(VALID_BODY)
    harness.deliver(b"{ not json")

    assert harness.watchdogs == []
