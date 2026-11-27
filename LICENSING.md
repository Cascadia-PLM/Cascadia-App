# Cascadia PLM Licensing

> **TL;DR:** Cascadia is open source under AGPL-3.0 — all of it, unlimited users,
> self-hosted, no artificial limits. There is no separate paid edition and no feature
> held back from this repository. Cascadia is dual-licensed: use it under the AGPL, or
> purchase a commercial license to the same code if the AGPL doesn't work for your
> organization.

## The model

Everything in this repository is free software under the
[GNU Affero General Public License v3.0 or later](./LICENSE), including:

- Parts, documents, requirements, tasks, and work instructions
- Multi-level BOM management and where-used queries
- Change management — the full ECO-as-Branch workflow
- Git-style versioning: branches, commits, merges, baselines
- Workflow engine, lifecycles, and revision schemes
- File vault with check-in/check-out (local or S3-compatible storage)
- RBAC, programs, and design hierarchy
- Enterprise search, reporting, import/export
- The REST and SysML v2 APIs
- The in-browser 3D viewer and CAD conversion service
- The AI chat assistant (bring your own API key)
- The Collaborative Design Engine (AI-assisted requirements → BOM → CAD generation),
  and the CAD generation workers it drives

Unlimited users. No feature meters. Self-host it in production without ever talking to us.
New capabilities land here, under the same license.

## Dual licensing

The open-source code is offered under the AGPL-3.0. The AGPL's network-use clause
requires that if you run a modified version as a network service, you make your
modified source available to the users of that service.

If the AGPL is incompatible with your organization's policies (common in defense and
other regulated industries), a **commercial license** to the same code is available —
no copyleft obligations. Support agreements, SLAs and hosting are available as well.

Contact: **kai@cascadiaplm.com**

## Contributions

External contributions require signing our [Contributor License Agreement](./CLA.md).
The CLA licenses your contribution to the project in a way that keeps dual licensing
possible; you retain ownership of your work. Signing happens automatically via a bot
comment on your first pull request.

## A note on history

Cascadia launched (April 2026) with all features, including AI features, in the AGPL
repository. For part of 2026 the Collaborative Design Engine and some enterprise
modules were developed in a separate commercial edition. In November 2026 that edition
was retired: the Design Engine returned to this repository under the AGPL, together
with the two CAD workers it drives, and there is no longer a separate commercial
codebase. Previously published AGPL versions of all code remain available under the
AGPL in the repository history, as that license is irrevocable for what was already
released.

---

_This document describes our licensing policy in plain language; it is not legal advice
and does not modify the terms of the [LICENSE](./LICENSE) or any commercial agreement._
