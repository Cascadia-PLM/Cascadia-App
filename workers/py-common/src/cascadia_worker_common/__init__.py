# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (c) 2026 Cascadia PLM LLC

"""Shared job-execution machinery for the Python job workers.

One copy of the jobs/vault SQL (JOBS-8): both workers used to carry a
~250-line db.py duplicated verbatim, and every fix had to land twice.
The same argument since brought the timeout watchdog here — enforcement
that must behave identically in both workers belongs in one file, not
two. This package is AGPL like the published cad-converter that depends
on it; the proprietary cad-generator depending on it mirrors the
modules-on-core relationship.

Consumed via PYTHONPATH (each worker image copies ``py-common/src``
alongside its own ``src``), not installed as a distribution.
"""
