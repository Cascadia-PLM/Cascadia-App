# Collaborative Design Engine

**Not included in this edition.** The Collaborative Design Engine ships in the
proprietary edition of Cascadia, licensed separately from the AGPL edition
published in this repository.

## What it does

A multi-stage AI workflow that takes a design brief to a materialized product
structure. The stages run in sequence, each drafting step paired with a review
step: toolset establishment, requirements, BOM, materialization, CAD generation,
and assembly composition.

"Materialization" is the point where it stops being a draft — the engine creates
real PLM items (parts, requirements, relationships) and an ECO to carry them,
using the same services any other client would.

## What is in this edition

The engine is a consumer of core, not a part of it. Everything it materializes
_into_ is here:

- `ItemService`, `ChangeOrderService`, and the rest of the service layer —
  [service-patterns.md](../development/service-patterns.md)
- The AI tool registry the engine registers its tools with —
  [ai-assistant.md](./ai-assistant.md)
- The job system its long-running stages dispatch through —
  [adding-background-jobs.md](../development/adding-background-jobs.md)

Related: [cad-services.md](./cad-services.md) for the CAD generation stages, and
[design-engine.md](../api/design-engine.md) for the API surface.

## Getting it

Offered under a separate written agreement by Cascadia PLM LLC. See the
[project README](../../README.md) for contact details.
