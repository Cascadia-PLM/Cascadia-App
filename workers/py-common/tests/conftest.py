# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Fixtures for the database-backed half of the py-common suite.

The suite runs against the real `jobs` schema — the one `npm run test:db:push`
builds from packages/core/src/lib/db/schema/jobs.ts — rather than DDL of its
own. Duplicating the table here would let the workers' SQL keep passing against
a shape the application no longer has, which is the only failure this suite
exists to catch.
"""

from __future__ import annotations

import os
import uuid
from typing import Any, Callable, Optional

import psycopg.types.json
import pytest

from cascadia_worker_common import db


@pytest.fixture(scope="session")
def database_url() -> str:
    """TEST_DATABASE_URL, never DATABASE_URL.

    These tests INSERT and UPDATE `jobs` rows. Pointed at a dev database they
    would write into whatever you were working on, which is why the TypeScript
    suite refuses to guess its database and why this one does not either.

    Missing locally is a skip with instructions. Missing under CI is an error:
    a suite that quietly skips every assertion is a green check that gates
    nothing, and that is worse than no check at all.
    """
    url = os.environ.get("TEST_DATABASE_URL")
    if url:
        return url
    message = (
        "TEST_DATABASE_URL is not set. Create a database for the suite, build "
        "its schema with `npm run test:db:push`, and put the URL in .env — see "
        "docs/development/testing.md. Run "
        "`pytest workers/py-common -m 'not db'` to skip these."
    )
    if os.environ.get("CI"):
        raise RuntimeError(message)
    pytest.skip(message)


@pytest.fixture(scope="session")
def worker_db(database_url: str):
    """The module under test, pointed at the test database."""
    db.configure(database_url)
    yield db
    db.close_connection()


@pytest.fixture
def make_job(worker_db) -> Callable[..., str]:
    """Insert a `jobs` row and return its id; delete it at teardown.

    Insert-and-delete rather than truncate: the TypeScript suite truncates the
    same tables, and a Python run that wiped them could pull the rug from under
    a concurrent vitest run. `item_id` and `created_by` are left NULL — both FKs
    are nullable, so no user or item has to exist for a job to.
    """
    created: list[str] = []
    conn = worker_db.get_connection()

    def _make(
        *,
        status: str = "running",
        attempts: int = 1,
        max_attempts: int = 3,
        retry_delays: Optional[list[int]] = None,
        job_type: str = "test.pycommon.job",
        payload: Optional[dict] = None,
    ) -> str:
        job_id = str(uuid.uuid4())
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO jobs "
                "(id, type, status, priority, payload, attempts, max_attempts, "
                "retry_delays, created_at) "
                "VALUES (%s, %s, %s, 'normal', %s, %s, %s, %s, NOW())",
                (
                    job_id,
                    job_type,
                    status,
                    psycopg.types.json.Json(payload or {}),
                    attempts,
                    max_attempts,
                    # Json(None) writes a JSON null, which is not the same row
                    # as a SQL NULL and not the pre-migration case under test.
                    None
                    if retry_delays is None
                    else psycopg.types.json.Json(retry_delays),
                ),
            )
        created.append(job_id)
        return job_id

    yield _make

    with conn.cursor() as cur:
        for job_id in created:
            cur.execute("DELETE FROM jobs WHERE id = %s", (job_id,))


@pytest.fixture
def read_job(worker_db) -> Callable[[str], Any]:
    """Read a whole `jobs` row as a tuple, for before/after comparison."""
    conn = worker_db.get_connection()

    def _read(job_id: str):
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM jobs WHERE id = %s", (job_id,))
            return cur.fetchone()

    return _read
