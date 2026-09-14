# Webhooks

Cascadia delivers domain events to an HTTP endpoint you control. A subscription
is a row an administrator creates at `/admin/webhooks`; the dispatcher that reads
those rows is core code. Adding a subscriber is an insert, not a deploy — the
worked example of the [code-and-data line](./extensibility.md#why).

This page is written for whoever has to **build the receiver**.

**Maturity.** Delivery, signing, retry, the circuit breaker and the delivery log
ship in v0.6.0. What is not closed: **DNS rebinding between our lookup and our
connection** (see [What is not closed](#what-is-not-closed)). A
**program-scoped subscription receives only what can be attributed to its
program**, and some facts cannot be — see [Program scope](#program-scope).
Delivery needs the **jobs worker** running: see [Running it](#running-it).

## Contents

- [The delivery](#the-delivery)
- [The body](#the-body)
- [Verifying a delivery](#verifying-a-delivery)
- [Your obligations as a receiver](#your-obligations-as-a-receiver)
- [How we read your response](#how-we-read-your-response)
- [The secret lifecycle](#the-secret-lifecycle)
- [Program scope](#program-scope)
- [Running it](#running-it)
- [What payloads never carry](#what-payloads-never-carry)
- [What is not closed](#what-is-not-closed)

## The delivery

A `POST` with a JSON body and these headers:

| Header                  | Value                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `content-type`          | `application/json`                                                                    |
| `user-agent`            | `Cascadia-Webhooks/1`                                                                 |
| `x-cascadia-event-id`   | The event's UUID. **Dedupe on this.**                                                 |
| `x-cascadia-event-type` | e.g. `design.released`, so you can route without parsing                              |
| `x-cascadia-signature`  | `t=<unix seconds>,v1=<hex hmac>` — see below. **Absent on an unsigned subscription.** |

Redirects are **not followed**: a 3xx is recorded as a permanent failure. Point
the subscription at the final URL.

## The body

```json
{
  "version": 1,
  "id": "f2b0c9d4-5e6a-4b7c-8d9e-0a1b2c3d4e5f",
  "seq": 10427,
  "type": "design.released",
  "schemaVersion": 1,
  "occurredAt": "2026-09-13T18:04:11.238Z",
  "queuedAt": "2026-09-13T18:04:11.402Z",
  "actorId": "7c1e5a90-3b44-4f21-9a8e-1d2c3b4a5f60",
  "subject": { "type": "design", "id": "…", "masterId": null },
  "context": { "programId": null, "designId": "…", "branchId": "…" },
  "payload": { "…": "event-type specific" },
  "correlationId": "…",
  "causationId": null
}
```

| Field           | Meaning                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `version`       | The **envelope** version. Bumped when this shape changes — not when a payload does.                                                  |
| `id`            | The event's identity. Stable across redeliveries. This is your dedupe key.                                                           |
| `seq`           | Commit-order position. Within one subscription, deliveries arrive in ascending `seq`.                                                |
| `type`          | The event type. `GET /api/v1/events/types` lists what an instance emits.                                                             |
| `schemaVersion` | The **payload** contract version for this `type`.                                                                                    |
| `occurredAt`    | The emitting transaction's start time. Every event of one transaction shares it, which is correct for an atomic fact.                |
| `queuedAt`      | When the delivery row was written. Not a freshness signal — use the signature timestamp for that.                                    |
| `actorId`       | Who caused it. **Null means the system itself**, not "unknown".                                                                      |
| `subject`       | What it is about. `masterId` is the identity that survives revisions, for versioned subjects.                                        |
| `context`       | `designId` and `branchId` when the fact has them; `programId` when the emitter could name one — see [Program scope](#program-scope). |
| `correlationId` | Groups the events of one logical operation. On a release it is the change order's id on every event.                                 |
| `causationId`   | The event that directly caused this one, when an extension emitted it.                                                               |

## Verifying a delivery

**Sign over the raw request bytes**, before any parsing. Over HTTP the bytes are
the artefact; re-serialising the JSON changes key order, number formatting and
unicode escaping, and your digest will not match ours.

The signed string is:

```
v1.<timestamp>.<raw body bytes>
```

joined with literal dots, where `<timestamp>` is the integer from the header's
`t=` field. The timestamp is **inside** the signed material, not merely beside
it: redelivery is a designed property here, so you cannot tell a legitimate
redelivery from an attacker's replay by novelty alone. You need a signed
freshness window _and_ dedupe on the event id.

The header format admits **a list** of signatures:

```
t=1760000000,v1=31d628fe…,v1=9a4c17b2…
```

Every delivery carries exactly one today. Verify against the list anyway, and
accept the delivery if **any** `v1=` value matches, so an overlap window or a
second scheme can be offered later without a change on your side.

```python
import hashlib, hmac, time

TOLERANCE_SECONDS = 300

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    timestamp, signatures = None, []
    for part in header.split(","):
        key, _, value = part.partition("=")
        key, value = key.strip(), value.strip()
        if key == "t":
            if timestamp is not None:
                return False          # two timestamps is malformed, not a choice
            if not value.isdigit():
                return False
            timestamp = int(value)
        elif key == "v1":
            signatures.append(value)

    if timestamp is None or not signatures:
        return False

    # Both directions. A timestamp far in the future would otherwise outlive
    # every window you could configure.
    if abs(int(time.time()) - timestamp) > TOLERANCE_SECONDS:
        return False

    expected = hmac.new(
        secret.encode(),
        f"v1.{timestamp}.".encode() + raw_body,
        hashlib.sha256,
    ).hexdigest()

    # Constant-time per comparison, and every candidate is compared: `any()`
    # would stop at the first match, so the loop accumulates instead.
    matched = False
    for candidate in signatures:
        if hmac.compare_digest(candidate, expected):
            matched = True
    return matched
```

> **Note.** The timestamp is ours, and it proves freshness relative to a clock
> you also have to trust. It is a replay window, not proof of when something
> happened — there is no trusted timestamping authority here.

## Your obligations as a receiver

1. **Verify before parsing.** An unverified body is attacker-controlled input.
2. **Reject a stale timestamp**, in both directions.
3. **Dedupe on `x-cascadia-event-id`.** Delivery is at-least-once _by design_ —
   this is not a bug we intend to fix. A redelivery carries the identical event
   id.
4. **Respond quickly and work asynchronously.** The request budget is ten
   seconds. Acknowledge, then do the work.
5. **Return 410 Gone to be switched off.** It is the one status that disables the
   subscription from your side, with the reason recorded for the administrator.
6. **Expect ordering within a subscription, not across subscriptions.** Events
   for one subscription arrive in ascending `seq`. Two subscriptions have no
   relationship.

## How we read your response

| Response                                  | Outcome                                                        |
| ----------------------------------------- | -------------------------------------------------------------- |
| 2xx                                       | Delivered; the subscription's consecutive-failure count resets |
| 410 Gone                                  | Failed **and the subscription is disabled** — you said stop    |
| Any other 4xx except 408 and 429          | Failed permanently on the first attempt; no retries            |
| 3xx (redirects are not followed)          | Failed permanently, recorded as a refused redirect             |
| 408, 429, any 5xx, network error, timeout | Retried with backoff, honouring a sane `Retry-After`           |

Six attempts over roughly three hours, then the delivery is **dead**: a permanent
record carrying its attempts, last status and error, visible in the delivery log.
Ordering of what _is_ delivered is preserved, and the hole is visible rather than
silent.

A delivery that has been waiting longer than three days is **expired** rather
than sent, so re-enabling a long-disabled subscription does not flood you with a
week of backlog — which would look exactly like an attack from your side.

**The circuit breaker** counts _dead deliveries_, not failed attempts: five
consecutive deaths disable the subscription with a reason. One flaky minute
cannot trip it; hours of sustained failure will.

## The secret lifecycle

- Generated at creation, returned **once**, in that response. It is stored
  encrypted and never readable again — a lost secret is rotated, not recovered.
- Rotation returns a new one, also once. **The old secret stops working
  immediately.** There is no overlap window on our side: a receiver bridges a
  rotation by verifying against both of _its_ own secrets until it has
  switched.
- An instance with no `ENCRYPTION_KEY` **refuses to create a signed
  subscription** rather than storing a signing key in the clear, and the delivery
  pump refuses to start if a signed subscription exists without one. An
  explicitly unsigned subscription is still possible for a receiver inside your
  own network.
- The administration API never returns the secret or its ciphertext. A short
  display prefix identifies it; that is all.

## Program scope

A subscription scoped to a program receives an event only when the event can
be attributed to that program, and **fails closed** otherwise: an event it
cannot attribute reaches unscoped subscriptions only, never every scoped one.

Attribution comes from the event's `context`. A fact about an item, a structure
edge, a file, a branch or a design carries its design, and a design belongs to
one program. A program's own facts carry the program. A change order belongs to
no design — it links any number — so its facts (`change_order.released`,
`change_order.cancelled`, and the `lifecycle.transitioned` and `approval.voted`
of its workflow) carry a program only when **every design it links belongs to
the same one**.

So a program-scoped subscription never receives:

- the facts of a change order whose designs span programs, or that links no
  design yet;
- facts about items outside any design, work orders included.

Subscribe unscoped and filter on the payload if you need those.

## Running it

Webhooks are sent by the **jobs worker**, not the web server. The worker runs
both halves: the dispatcher that turns committed events into delivery rows, and
the pump that sends them. The app process runs neither, so an instance with no
worker accepts subscriptions and delivers nothing — the administration page
says so when it can see that no worker is running the dispatcher.

The worker's health endpoint reports `webhookPump`: `running`, or `not_running`
when the pump refused to start because a signed subscription exists and
`ENCRYPTION_KEY` is not set. Neither changes the health verdict.

## What payloads never carry

- **No secrets, credentials or tokens.**
- **No file contents.** A file event carries ids and a name, never bytes.
- **No response bodies from other systems.**
- **Payloads point rather than snapshot** — ids and the few fields you could not
  reconstruct, not a copy of the row. Read the API for current state; the event
  tells you _what happened_, not what everything looks like now.

Events do carry item numbers, names, file names and actor ids — the same
sensitivity class as lifecycle history. Treat a webhook target as a disclosure
boundary.

## What is not closed

**DNS rebinding between our lookup and our connection.** We resolve a target's
host and refuse it if _any_ returned address is loopback, link-local, private,
carrier-grade NAT, benchmarking, multicast, reserved, IPv4-compatible or
local-use NAT64 — any, not the first, because a hostile name can answer with one
public address and one private one. A host that does not resolve at all is
retried like a connection failure rather than refused for good.
But a name that resolves to a public address at check time can resolve to a
private one when the socket opens milliseconds later. Closing that needs a custom
dispatcher that connects to the vetted address while preserving the Host header.

What raises the cost meanwhile: the check runs on **every delivery**, so a
rebind has to win a race repeatedly rather than being configured once, and
redirects are not followed, which removes the cheap version of the same attack.
This is stated rather than implied because an unstated gap is worse than a known
one.

---

**See also:** [Extensibility](./extensibility.md) ·
[Operating event consumers](../admin/event-consumers.md) ·
[SECURITY.md](../../SECURITY.md#outbound-webhooks)
