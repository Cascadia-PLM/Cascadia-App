# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""How ``_run_job`` settles a delivery.

A RabbitMQ delivery is a job's only copy, so the settlement is what decides
whether the job survives. These tests pin the same four outcomes the
generator's suite pins — dead-letter, requeue, ack-without-execute, ack —
plus the one this worker adds: a script that *fails* is a completed job, and
acks, and never reaches ``mark_job_failed``.

The watchdog wiring rides the same seam and is covered here too.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from types import ModuleType
from typing import Any, Callable, Optional
from unittest.mock import MagicMock

import pytest

# Importing the worker drags in pika and psycopg at import time. Stub ONLY
# what is genuinely absent so a plain `pip install pytest pydantic
# pydantic-settings` runs this file; an installed package always wins.


class _StubModule(ModuleType):
    def __getattr__(self, name: str) -> Any:
        return MagicMock(name=f"{self.__name__}.{name}")


class _StubLoader:
    def is_package(self, fullname: str) -> bool:
        return True

    def create_module(self, spec: Any) -> ModuleType:
        return _StubModule(spec.name)

    def exec_module(self, module: ModuleType) -> None:
        pass


class _StubFinder:
    def __init__(self, root: str) -> None:
        self._root = root
        self._prefix = f"{root}."

    def find_spec(self, fullname: str, path: Any = None, target: Any = None) -> Any:
        if fullname != self._root and not fullname.startswith(self._prefix):
            return None
        return importlib.util.spec_from_loader(fullname, _StubLoader())


def _stub_if_absent(*roots: str) -> None:
    for root in roots:
        if importlib.util.find_spec(root) is None:
            sys.meta_path.append(_StubFinder(root))


_stub_if_absent("pika", "psycopg")

from freecad_runner import worker  # noqa: E402 — must follow the stubs above
from freecad_runner.models import FreecadScriptResult, JobRecord  # noqa: E402

DELIVERY_TAG = 7
JOB_ID = "11111111-1111-4111-8111-111111111111"

VALID_BODY = json.dumps(
    {
        "jobId": JOB_ID,
        "type": "generation.cad.freecad",
        "priority": 5,
        "attemptNumber": 1,
    }
).encode()

CLAIMED_JOB = JobRecord(
    id=JOB_ID,
    type="generation.cad.freecad",
    status="running",
    payload={
        "script": "import Part\nresult = Part.makeBox(1, 1, 1)\n",
        "partName": "Bushing",
        "userId": "55555555-5555-4555-8555-555555555555",
        "persist": False,
    },
)


class FakeChannel:
    def __init__(self) -> None:
        self.is_open = True
        self.acks: list[int] = []
        self.nacks: list[tuple[int, bool]] = []

    def basic_ack(self, delivery_tag: int) -> None:
        self.acks.append(delivery_tag)

    def basic_nack(self, delivery_tag: int, requeue: bool) -> None:
        self.nacks.append((delivery_tag, requeue))


class FakeConnection:
    is_open = True

    def add_callback_threadsafe(self, callback: Callable[[], None]) -> None:
        callback()


class StartedWatchdog:
    def __init__(self, kwargs: dict[str, Any]) -> None:
        self.kwargs = kwargs
        self.cancels = 0

    def cancel(self) -> None:
        self.cancels += 1


class Harness:
    def __init__(self, channel: FakeChannel) -> None:
        self.channel = channel
        self.claims: list[str] = []
        self.failures: list[tuple[str, str]] = []
        self.completions: list[tuple[str, dict]] = []
        self.executions: list[str] = []
        self.watchdogs: list[StartedWatchdog] = []

    def deliver(self, body: bytes) -> None:
        worker._worker_slots.acquire()
        worker._run_job(self.channel, DELIVERY_TAG, body)


@pytest.fixture
def harness(monkeypatch: pytest.MonkeyPatch) -> Harness:
    h = Harness(FakeChannel())

    monkeypatch.setattr(worker, "_connection", FakeConnection())
    monkeypatch.setattr(worker, "add_job_log", lambda *a, **k: None)
    monkeypatch.setattr(
        worker,
        "mark_job_completed",
        lambda job_id, result: h.completions.append((job_id, result)),
    )
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
    monkeypatch.setattr(worker.settings, "claim_retry_delay_seconds", 0)

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
    def _claim_job(job_id: str) -> Optional[JobRecord]:
        h.claims.append(job_id)
        if raises is not None:
            raise raises
        return returns

    return _claim_job


def _execution(
    h: Harness,
    *,
    ok: bool = True,
    raises: Optional[Exception] = None,
) -> Callable[..., FreecadScriptResult]:
    def _execute(job_id: str, payload: Any) -> FreecadScriptResult:
        h.executions.append(job_id)
        if raises is not None:
            raise raises
        return FreecadScriptResult(
            ok=ok,
            executionTimeMs=5,
            errorMessage=None if ok else "NameError: name 'x' is not defined",
            issues=[] if ok else ["NameError: name 'x' is not defined"],
        )

    return _execute


def test_claim_failure_requeues_the_delivery(harness: Harness, monkeypatch):
    monkeypatch.setattr(
        worker,
        "claim_job",
        _claim(harness, raises=RuntimeError("connection to the database failed")),
    )

    harness.deliver(VALID_BODY)

    assert harness.claims == [JOB_ID]
    assert harness.channel.nacks == [(DELIVERY_TAG, True)]
    assert harness.channel.acks == []
    assert harness.failures == []


def test_unclaimable_job_acks_without_executing(harness: Harness, monkeypatch):
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=None))
    monkeypatch.setattr(worker, "_execute_script_job", _execution(harness))

    harness.deliver(VALID_BODY)

    assert harness.channel.acks == [DELIVERY_TAG]
    assert harness.channel.nacks == []
    assert harness.executions == []


def test_unparseable_body_is_dead_lettered(harness: Harness):
    harness.deliver(b"{ not json")

    assert harness.channel.nacks == [(DELIVERY_TAG, False)]
    assert harness.channel.acks == []
    assert harness.claims == []
    assert harness.failures == []


def test_successful_run_acks_exactly_once(harness: Harness, monkeypatch):
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=CLAIMED_JOB))
    monkeypatch.setattr(worker, "_execute_script_job", _execution(harness))

    harness.deliver(VALID_BODY)

    assert harness.executions == [JOB_ID]
    assert harness.channel.acks == [DELIVERY_TAG]
    assert harness.channel.nacks == []
    assert [job_id for job_id, _ in harness.completions] == [JOB_ID]


def test_a_failing_script_is_a_completed_job_not_a_failed_one(
    harness: Harness, monkeypatch
):
    """The agent's retry is a corrected script; the job system's retry is not."""
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=CLAIMED_JOB))
    monkeypatch.setattr(worker, "_execute_script_job", _execution(harness, ok=False))

    harness.deliver(VALID_BODY)

    assert harness.failures == []
    assert len(harness.completions) == 1
    _, result = harness.completions[0]
    assert result["ok"] is False
    assert result["errorMessage"].startswith("NameError")
    assert harness.channel.acks == [DELIVERY_TAG]


def test_an_infrastructure_fault_records_the_failure_and_acks(
    harness: Harness, monkeypatch
):
    """Past the claim, retries are scheduled by status — so a failure acks."""
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=CLAIMED_JOB))
    monkeypatch.setattr(
        worker,
        "_execute_script_job",
        _execution(harness, raises=RuntimeError("FreeCAD is not importable")),
    )

    harness.deliver(VALID_BODY)

    assert [job_id for job_id, _ in harness.failures] == [JOB_ID]
    assert harness.completions == []
    assert harness.channel.acks == [DELIVERY_TAG]
    assert harness.channel.nacks == []


def test_a_claimed_job_is_watched_on_its_configured_timeout(
    harness: Harness, monkeypatch
):
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=CLAIMED_JOB))
    monkeypatch.setattr(worker, "_execute_script_job", _execution(harness))

    harness.deliver(VALID_BODY)

    assert len(harness.watchdogs) == 1
    started = harness.watchdogs[0]
    assert started.kwargs["job_id"] == JOB_ID
    assert started.kwargs["timeout_ms"] == worker.settings.job_timeout
    assert started.kwargs["poison_grace_ms"] == worker.settings.poison_exit_grace_ms
    assert started.kwargs["job_thread_alive"]() is True
    assert started.cancels == 1


def test_a_failed_job_still_calls_off_its_watchdog(harness: Harness, monkeypatch):
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=CLAIMED_JOB))
    monkeypatch.setattr(
        worker,
        "_execute_script_job",
        _execution(harness, raises=RuntimeError("boom")),
    )

    harness.deliver(VALID_BODY)

    assert [w.cancels for w in harness.watchdogs] == [1]


def test_a_delivery_that_claims_nothing_is_never_watched(harness: Harness, monkeypatch):
    monkeypatch.setattr(worker, "claim_job", _claim(harness, returns=None))

    harness.deliver(VALID_BODY)
    harness.deliver(b"{ not json")

    assert harness.watchdogs == []
