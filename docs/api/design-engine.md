# Design Engine API

**Not included in this edition.** The `/api/v1/design-engine/*` endpoints are
part of the proprietary edition of Cascadia and are not served by a build of
this repository.

A request to one of them returns 404 here — the routes are contributed by the
module, not by core, so they are absent rather than gated. See
[design-engine.md](../features/design-engine.md) for what the feature does.

## The API in this edition

Everything the design engine ultimately writes through is documented and
available:

- [Items](./items.md) — parts, documents, and the rest
- [Change Orders](./change-orders.md) — ECOs, the unit the engine materializes into
- [Files](./files.md) — vault upload and download
- [AI Chat](./ai-chat.md) — the assistant and its tool registry

The full contract for this edition is in
[openapi.v1.json](./openapi.v1.json), served interactively at `/api/docs`.
