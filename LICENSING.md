# Cascadia PLM Licensing

> **TL;DR:** The core PLM is open source under AGPL-3.0, forever — unlimited users,
> self-hosted, no artificial limits. Enterprise capabilities are commercially licensed
> and fund the open core. Cascadia is dual-licensed: use it under the AGPL, or purchase
> a commercial license if the AGPL doesn't work for your organization.

## The model

Cascadia uses an **open-core, dual-license** model.

### Open core — AGPL-3.0, forever

The core product lifecycle management system is and will remain free software under the
[GNU Affero General Public License v3.0](./LICENSE):

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

Unlimited users. No feature meters. Self-host it in production without ever talking to us.

### Commercial edition — paid, funds the roadmap

Capabilities aimed at enterprise deployment are licensed commercially and are not part
of the AGPL distribution:

- Native CAD connectors (Solid Edge, SolidWorks, and future connectors)
- SSO / Active Directory / LDAP integration
- Compliance & audit pack (audit reports, CUI marking support, export-control flags)
- The Collaborative Design Engine (AI-assisted requirements → BOM → CAD generation)
- Sovereign AI deployment options (GovCloud / self-hosted model support)
- Priority support and SLAs; managed and sovereign hosting

### The dividing line

Our standing rule for every future feature:

> **If a single engineering team needs it to do daily PLM work, it's open.
> If it's enterprise integration, governance, or premium automation, it's commercial.**

We publish this rule so you can predict where any future capability will land.

## Dual licensing

The open-source code is offered under the AGPL-3.0. The AGPL's network-use clause
requires that if you run a modified version as a network service, you make your
modified source available to the users of that service.

If the AGPL is incompatible with your organization's policies (common in defense and
other regulated industries), a **commercial license** to the same code is available —
no copyleft obligations, plus access to the commercial edition and support.

Contact: **kai@cascadiaplm.com**

## Contributions

External contributions require signing our [Contributor License Agreement](./CLA.md).
The CLA licenses your contribution to the project in a way that keeps dual licensing
possible; you retain ownership of your work. Signing happens automatically via a bot
comment on your first pull request.

## A note on history

Cascadia launched (April 2026) with all features, including AI features, in the AGPL
repository. As of this policy, the Collaborative Design Engine is moving to the
commercial edition; previously published AGPL versions of that code remain available
under the AGPL in the repository history, as that license is irrevocable for what was
already released. Everything listed under "Open core" above stays AGPL going forward.

---

*This document describes our licensing policy in plain language; it is not legal advice
and does not modify the terms of the [LICENSE](./LICENSE) or any commercial agreement.*
