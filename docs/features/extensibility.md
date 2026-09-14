# Extensibility

Cascadia lets you change what the system does when something happens, without
forking it. A **domain event log** records every business fact in the same
transaction as the change it describes, and an **extension layer** with three
phases lets code react to those facts — refusing an operation before it happens,
committing alongside it, or catching up on it durably afterwards.

Handler bodies are TypeScript in a compiled package. Enablement, subscriptions
and parameters are rows. That line is the whole design: **code decides what runs;
data decides whether, where and with what parameters.**

**Maturity.** The log, all three phases, webhook delivery and the ERP connector
ship in v0.6.0 and are used by first-party code in production paths. What is not
true yet, stated plainly: **event coverage is not universal** — more than a
dozen non-test files write `items` outside `ItemService`, so "every update fires
`item.updated`" is false of this tree, and a lifecycle transition writes `items`
and fires no `item.updated` at all (see [Gaps](#known-gaps)). **Not every fact
names a program**: a fact about something outside any design carries none, and a
program-scoped consumer must read a missing program as "not mine".
**The extension surface is not a stability promise to third parties** — the
published barrel exists, but a supported out-of-repository registration point, a
versioning commitment, and the AGPL-linking question are open maintainer
decisions, so today this is a first-party and module-author surface. And
**webhook DNS rebinding is not closed** (see
[Webhooks](./webhooks.md#what-is-not-closed)).

## Contents

- [Why](#why)
- [Architecture](#architecture)
- [The three phases](#the-three-phases)
- [The event catalog](#the-event-catalog)
- [The ordering guarantee](#the-ordering-guarantee)
- [The consumption contract](#the-consumption-contract)
- [What the log deliberately does not say](#what-the-log-deliberately-does-not-say)
- [What the extension surface deliberately does not offer](#what-the-extension-surface-deliberately-does-not-offer)
- [Configuration](#configuration)
- [Known gaps](#known-gaps)
- [Roadmap](#roadmap)
- [Design decisions](#design-decisions)

## Why

Traditional PLM systems are configured by writing code into the database — Aras
puts JavaScript in a `Method` row, Teamcenter has ITK handlers, Windchill has
listeners. That buys runtime extensibility and costs everything a compiler and a
test suite give you: no type checking, no diff, no review, no test.

Cascadia's answer is that **handler bodies are code and selectors are data**.
A webhook subscription is a row, so adding a subscriber is an insert. The
dispatcher that reads those rows is TypeScript, compiled, reviewed and tested.

The defect that made this urgent is worth naming, because it is the argument in
one sentence. The ERP connector's release trigger was a post-commit hook, and the
loop that called it lived inside `mergeBranchToMain` alone — so a change order
releasing through the branchless arm fired **no hook at all**, and nothing
recorded that one was owed. A seam whose failures are swallowed cannot report its
own gaps. The log records the fact; a consumer keys on the fact rather than on
one code path; and a failure is a row an operator can see.

## Architecture

```
                    ┌─ guard ─────────── before the operation's own writes.
                    │                    May refuse. Runs on the operation's
                    │                    own handle. Must be side-effect-free.
one operation ──────┤
                    ├─ the write, and in the SAME transaction:
                    │     domain_events row (seq null until COMMIT)
                    │     in-transaction extensions (commit with the fact)
                    │
                    └─ COMMIT ── deferred trigger assigns seq
                                 └─ seq order == commit order
                                          │
                    ┌─────────────────────┴─────────────────────┐
                    │              the event log                 │
                    └─────────────────────┬─────────────────────┘
                                          │ polled, per-consumer cursor
              ┌───────────────┬───────────┴────────┬──────────────────┐
     consumed extensions   RabbitMQ relay    webhook dispatcher   ERP connector
     (watermarks, alerts)  (a consumer,      (fan-out to rows)    (design.released)
                            not the bus)
```

The log is the bus. The broker is a **consumer**, not the transport — which is
why a broker outage costs latency and never events: the relay's cursor stops, the
outage ends, the relay catches up in order.

## The three phases

| Phase            | Binds to     | Runs                               | On failure                                                              | Can refuse |
| ---------------- | ------------ | ---------------------------------- | ----------------------------------------------------------------------- | ---------- |
| `guard`          | an operation | before the operation's own writes  | a refusal reaches the caller as a 422 with its reason; a throw is a 500 | **yes**    |
| `in-transaction` | a fact       | inside the emitting transaction    | the whole transaction rolls back, the fact included                     | no         |
| `consumed`       | a fact       | after commit, from the durable log | recorded on the cursor row; retried with backoff; parked at threshold   | no         |

**`guard` binds to an operation; the other two bind to a fact.** This is not a
naming convention. A fact has already happened — `item.created` is a record of
something true — so there is nothing to veto. An _operation_ is an intent, and an
intent is the only thing a veto makes sense against. So guards attach to
`item.create`, `item.update`, `item.delete`, `lifecycle.transition` and
`approval.vote`; everything else attaches to a past-tense event type.

### Three honest corrections to the guard contract

**A guard does not always run outside a transaction.** An operation that runs
inside a caller's transaction runs its guard there too, handed that
transaction's handle, so a guard never reads a connection that cannot see the
work it is about to refuse. The contract is therefore "before this operation's
own writes", not "outside any transaction". An item update is guarded on both
paths it takes — a direct edit, and a save of a change order's working copy —
and its intent carries the item's state as an id with the lifecycle's flags for
it, never a state name to compare against.

**A release dispatches no guards.** The release machinery calls `ItemService.update`
with `allowLifecycleFields`, `bypassBranchProtection` and `skipAccessCheck` —
flags whose doc comments already reserve them for the release machinery. Extension
dispatch joins that set. A release is executing decisions the lifecycle already
approved; its veto point is the transition that approved them, not each of the
eighty writes that implement it. Without this rule, one badly written customer
rule bricks every release in a plant, and a `guard` throw inside a retried
serializable closure aborts a partially-written release rather than refusing
cleanly. This is not Aras's `serverEvents="0"`, which was a request attribute any
client could set: it is unreachable from the wire.

**A guard runs on the read path too, so it must be side-effect-free.**
`getAvailableTransitions` evaluates guards to drive the UI, and its own doc
comment says the preview predicts what execution will decide. A guard bound only
to `transition()` would make the interface offer a transition that then fails —
exactly the silent divergence this layer exists to remove — so the preview
dispatches too, in an explicit `preview: true` mode. That is the single exception
to the no-read-path rule below, and it is named here rather than left to be
discovered.

## The event catalog

`GET /api/v1/events/types` answers this at runtime for the build you are running.
A type absent there is a type nothing in that instance publishes.

| Family    | Types                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Items     | `item.created`, `item.updated`, `item.deleted`, `item.released`, `item.obsoleted`, `item.checked_out`, `item.checked_in`, `item.checkout_cancelled` |
| Change    | `change_order.released`, `change_order.cancelled`, `design.released`, `lifecycle.transitioned`, `approval.voted`                                    |
| Structure | `relationship.added`, `relationship.removed`, `relationship.updated`                                                                                |
| Hierarchy | `program.created`, `design.created`, `branch.created`, `branch.archived`                                                                            |
| Files     | `file.uploaded`, `file.checked_in`, `file.deleted`, `file.restored`                                                                                 |
| Work      | `work_order.run_completed`, `work_order.sign_off_submitted`                                                                                         |

Two conventions hold across all of them. **Payloads point rather than snapshot** —
an event carries ids and the few fields a consumer cannot reconstruct, not a copy
of the row, because a snapshot is stale the moment it is written. And **flags,
never state names**: `work_order.run_completed` carries `countsTowardRequired`
rather than a status string, so a consumer never has to know which of six
literals are countable and does not break when a seventh appears.

## The ordering guarantee

**For any two committed events, seq order is commit order.** A plain
`seq > cursor` scan can therefore never skip an event that becomes visible later.

This is the one genuinely hard problem in a Postgres outbox, and the reason is
worth keeping: **a sequence default is not safe to cursor over.** Values are
assigned at insert time, but transactions commit in any order — a transaction
holding seq 5 can commit after one holding seq 6, and a reader that advanced past
6 has lost 5 _forever_. An ECO merge racing a quick item-create is exactly that
interleaving.

So `seq` is null at insert and assigned **when the transaction commits**, by a
deferred constraint trigger that takes an advisory lock and calls `nextval`.
Deferred constraint triggers run inside `COMMIT`, after all of the transaction's
own work, so the exclusive lock is held only for the commit tail, whatever the
transaction did before it. That tail includes the WAL flush, so concurrent
emitting commits serialise on fsync latency: a ceiling on emitting throughput
this design accepts, and one far above today's write rates.

### Why the advisory-lock fence was retired

The first design kept insert-time seqs and added a fence: publishers held an
advisory lock _shared_ from emit to commit, and a consumer briefly took it
_exclusive_, proving no publisher was in flight. Correct, and publishers never
blocked each other.

Re-landing it exposed the flaw. **Postgres queues new shared requests behind a
waiting exclusive one**, so a consumer waiting on one slow publisher blocks every
new publisher in the system until that publisher commits. The test suite
demonstrated it: one file's stalled publisher held the lock, every consumer fence
in every other fork queued behind it, and every fresh emission queued behind
_them_ — 60-second timeouts in three suites, and an unrelated lifecycle suite went
from 4 seconds to 183. That is not a test artefact: any long-running transaction
that emitted early would do the same in production, and "emit last" is a
discipline, not a guarantee.

| Approach                                | Verdict                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| Sequence default, ignore the race       | Silent, permanent event loss under concurrency — disqualifying                 |
| Poll with a safety lag                  | Still loses events from transactions longer than the lag                       |
| Shared/exclusive fence                  | Correct, but a waiting fence stalls every new publisher — a system-wide convoy |
| Exclusive lock at emit, no fence        | Correct; serialises from emit to commit                                        |
| `xmin`-horizon fencing                  | Gapless, but any idle transaction stalls consumers, and order is not causal    |
| **Deferred trigger at commit (chosen)** | Commit order, no waits, nothing held across application work                   |
| Logical decoding / WAL                  | The eventual scale-out answer; heavy machinery for today's write rates         |

Costs, all accepted: two row versions per event; DDL drizzle-kit cannot express,
so the trigger ships in the migration _and_ every emitting or consuming process
ensures it at boot, both idempotent; `publishDomainEvent` returns no seq, because
it does not exist until commit; and a transaction that fails after the trigger ran
leaves a hole in the sequence, which is a finished transaction and harmless to
skip.

**What commit order buys.** Causality is preserved: an extension reacting to
`change_order.released` is guaranteed that every `design.released` and
`item.released` beneath it is already visible, without parsing payloads or waiting
on a timer.

## The consumption contract

Each `consumed` extension owns a cursor row in `event_consumers` and receives
matching events **in seq order, at least once**. The cursor advances in the same
transaction as the handler's own writes, so a handler's work and its progress
commit together or not at all.

Five rules follow, and none of them is optional:

1. **Handlers must be idempotent.** Delivery is at-least-once by design. A
   handler that submits a job passes a `dedupeKey` and the job system submits it
   once; any other external effect needs a durable key of its own — see
   [writing-extensions](../development/writing-extensions.md#idempotency).
2. **Handlers must use `ctx.tx`**, never the module-level connection. A read on
   `db` answers from a different snapshot than the cursor about to advance.
3. **Handlers must not reach the outside world under the cursor lock.** The
   runner holds the cursor row `FOR UPDATE` for the whole run, so an HTTP call
   there holds it for up to the handler deadline per event across a batch.
4. **Nothing is ever skipped automatically.** A failing handler stops its
   consumer; an operator resumes or skips it deliberately, and a skip is recorded.
5. **Handlers must honour `ctx.signal`**, which aborts at the handler deadline.

Two things the runtime does for a handler that cannot be trusted to. **A handler
that overruns its deadline has its whole run rolled back**, and a write it
attempts after the abort is refused, so a handler that ignored the signal cannot
commit half its work alongside the failure record. And **a failure the runtime
recognises as infrastructure** — a refused or dropped connection, the database
restarting, the broker unreachable — backs off like any other but never counts
toward parking, so an outage costs latency rather than an operator's ticket.

## What the log deliberately does not say

A consumer that reads the structure stream as complete genealogy will be wrong.
These exclusions are decisions, each with a reason:

| Not emitted                                  | Why                                                                                                                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The version-carry path                       | A checkout mints a working copy carrying every edge forward. Emitting there would turn one checkout into a BOM storm of edges nobody edited.                                                                             |
| The release's re-pointing of edges           | Same reason: mechanical, derived from edits already recorded, and high-volume.                                                                                                                                           |
| `Consumes` / `Produces` / `Evidences`        | Physical traceability edges are records of shop-floor events, not hand-edited structure. `work_order.*` covers what changed there.                                                                                       |
| The masters and edges a clone or MBOM copies | Both copy a whole design in one operation. The new design itself is announced, as `design.created`.                                                                                                                      |
| `physical_part.registered`                   | Its write delegates to a service owning its own transaction, so the event would commit separately from the row — the first crack in the outbox contract.                                                                 |
| `branch.deleted`                             | Nothing deletes a branch. Deleting a workspace archives it: one `branch.archived`, an `item.deleted` per discarded draft and an `item.checkout_cancelled` per released lock.                                             |
| File version carry and promotion             | A new item version starts with copies of its predecessor's file rows, and a release makes a branch's files visible on main: the same files, not new ones. `itemMasterId` on every file fact follows a file through both. |
| `change_order.scope_added` / `scope_removed` | Considered and not shipped. A change order's affected items have a history of their own, and no consumer has needed the facts yet.                                                                                       |
| A lifecycle transition's `items` write       | It writes `state`, `modifiedAt` and `modifiedBy` directly and fires no `item.updated`. `lifecycle.transitioned` carries the semantics.                                                                                   |

**`relationship.*` is the hand-edited structure stream.** That boundary is stated
in the definition's own docstring as well as here, because it is the one a
consumer is most likely to get wrong.

## What the extension surface deliberately does not offer

| Not offered                                     | Evidence                                                                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A post-commit, in-process, best-effort phase    | The one seam shaped that way silently never ran on two of three release arms for as long as it existed. That is the argument, not a preference.                                                            |
| A "replacement" phase that supplants core logic | Aras's approach; it makes the product's own behaviour unreviewable and unupgradable.                                                                                                                       |
| A read-path extension point                     | Except the `guard` preview named above, which exists so the UI cannot offer a transition that then fails.                                                                                                  |
| A client-controlled bypass                      | Aras's `serverEvents="0"` was a request attribute any client could set. The release bypass here is unreachable from the wire.                                                                              |
| A priority integer                              | Ordering between extensions of one phase is not a contract. Two extensions that must order are one extension.                                                                                              |
| A guard that amends                             | A guard refuses or passes, and its handler's return type admits nothing else. An amending guard would make what a user submitted and what was written differ by code nobody reviewing the request can see. |
| A durable record of refusals                    | A refusal is the caller's 422 and an info-level log line. Nothing durable is written: a refused operation changed nothing, and the record that matters — what did change — is the log itself.              |
| Handler source in a database row                | The line this whole design rests on.                                                                                                                                                                       |

## Configuration

| Variable                          | Default | Meaning                                                                                                                  |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| `EVENT_POLL_INTERVAL_MS`          | `2000`  | How often a process polls its registered consumers                                                                       |
| `EVENT_CONSUMER_PARK_AFTER`       | `10`    | Consecutive failures before a consumer parks                                                                             |
| `EVENT_CONSUMERS_IN_APP`          | `true`  | Whether the app server polls consumers as well as the jobs worker                                                        |
| `EVENT_RETENTION_DAYS`            | `90`    | Days of event history kept, and how long a consumer may stay parked before it is abandoned; zero or less retains forever |
| `WEBHOOK_PUMP_INTERVAL_MS`        | `5000`  | How often the delivery pump looks for pending webhook deliveries                                                         |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30`    | Days of webhook delivery history kept                                                                                    |

Full descriptions in
[orchestration/configuration.md](../orchestration/configuration.md).

**Switching an extension off is data, not configuration.** The `extensions.disabled`
settings row holds a list of extension ids, read per dispatch and cached for five
seconds, so an operator can stop a misbehaving extension without a rebuild. The
other half is the extension's own `enabled` declaration, where a module says it
is not licensed or not configured here; `GET /api/v1/extensions` reports which
of the two switched an extension off.

## Known gaps

1. **Not every fact names a program.** `context.programId` is set by
   `program.created`, `design.created`, and a change order's facts when every
   design it links belongs to one program; most other facts name a design, and a
   design names its program. A fact about something outside any design — an item
   with no design, a work order outside one, a change order spanning programs —
   carries neither, and a program-scoped consumer must read that as "not mine":
   a "null means all" reading leaks every program to every scoped subscriber. The
   webhook dispatcher fails closed on exactly that.
2. **Event coverage is asymmetric.** More than a dozen non-test files write
   `items` outside `ItemService`, three of them HTTP route handlers, so "every
   update fires `item.updated`" is not true of this tree today; each writer has a
   verdict in `item.updated`'s definition. The worst is the item detail route's
   `sync-properties` handler: mounted, gated by the item type's update
   permission, and writing `name`, `state` and part fields with no event at all,
   because its direct `state` write is a lifecycle-rule question to settle
   before an emit is added.
3. **A lifecycle transition fires no `item.updated`**, as above. A rule written
   against "any change to this item" misses the most important change in a PLM
   system.
4. **A lifecycle `update_field` action writes outside its transaction**, through
   the module-level connection, so it does not roll back with the transition that
   ran it. A live atomicity defect adjacent to this work, filed separately.
5. **Registry caches are process-local and there are two replicas by default.**
   An administrator's item-type or lifecycle edit reaches one replica and leaves
   the others serving a stale merged config. `LISTEN/NOTIFY` is the right answer;
   minting durable event types for an internal cache concern is not.
6. **An `in-transaction` extension extends the lock window** of whatever
   transaction it joins. The `tx`-only rule is the mitigation and is not a hard
   stop: `import { db }` is one line away in a package the compiler accepts.
7. **The relay has publisher confirms; the jobs path does not.** A job's broker
   publish still completes on buffer acceptance rather than broker persistence.
8. **A regenerated migration drops the sequencing trigger.** drizzle-kit cannot
   express triggers. `db:check-migrations` asserts its presence after migrate, so
   this is machine-checked rather than remembered.
9. **Payload sensitivity.** Events carry item numbers, names, file names and
   actor ids — the same class as lifecycle history — and the log is instance-wide
   by design. Retention and webhook payloads treat them accordingly.
10. **The registry is per process.** The introspection route and the consumers
    panel answer for the process serving them. The RabbitMQ relay and the webhook
    dispatcher are registered only in the jobs worker, so the app process lists
    them as registered elsewhere — and an instance with no worker accepts webhook
    subscriptions and delivers nothing. The webhooks page warns when it can see no
    worker running the dispatcher.
11. **A consumer that has never run protects nothing.** Retention's floor is the
    lowest cursor, and a registered consumer that has not polled yet — a worker
    that is down, an extension not yet enabled — has no cursor, so events older
    than the window can be pruned before its first run. That is what an `origin`
    consumer promises anyway: it replays what is still retained, not everything
    ever written.

## Roadmap

- **Routing `JobService.submit` through the outbox.** Job submission still
  commits outside the emitting transaction, which is the one remaining dual
  write. Its _consequence_ is closed — a submission carrying a `dedupeKey` is
  idempotent, so a rolled-back run cannot produce a second job — but the write
  itself is still two writes, and an outbox would make it one.
- **`LISTEN/NOTIFY` wake-up**, replacing polling latency and separately fixing
  the cross-process registry-cache staleness in gap 5.
- **Opening `GuardType` to registration**, so a customer can contribute a guard
  kind rather than only a handler. A coherent stage on its own: the evaluator is
  synchronous, its context carries no database handle, and the config is a closed
  union persisted as JSONB.
- **A third-party stability promise** — a supported registration point outside
  this repository, a versioning commitment on the published barrel, and an answer
  to whether an extension linked against AGPL core and served over a network must
  be disclosed. The last is a maintainer decision that determines whether the
  other two are worth building.

## Design decisions

- **A Postgres log as the bus, with the broker as a consumer.** Durability and
  ordering come from the database that already holds the truth; a broker outage
  costs latency, never events.
- **Commit-time sequencing over an advisory-lock fence.** The fence was correct
  and convoyed the whole system. See above.
- **Guards bind to operations, everything else to facts.** A fact cannot be
  vetoed.
- **Handler bodies are code; enablement and subscriptions are data.** The line
  the product is built on.
- **No post-commit best-effort phase**, because the one seam shaped that way
  silently skipped two of three release arms.
- **At-least-once with ordering, not exactly-once.** Exactly-once across a
  process boundary is not available; ordering plus idempotency is, and it is
  cheaper to reason about.
- **Payloads point rather than snapshot**, and carry flags rather than state
  names.
- **Guards refuse; they never amend**, and a refusal is not recorded durably. A
  refused operation changed nothing: the caller gets a 422 with the reason, and
  the refusal is logged at info.
- **Extensions run with the operation's identity**, on its own handle, rather
  than as a principal of their own. Extension code is first-party code reviewed
  into this repository; a separate identity would add configuration without
  adding a boundary.
- **A throwing `enabled` predicate skips a guard or in-transaction extension, but
  not a consumed one.** Inside a user's write, an extension that cannot say it
  belongs here does not act; after commit it runs, and its failure is visible on
  its cursor. The operator's disabled-list row fails open in every phase.
- **Infrastructure failures never park a consumer.** Ten handler failures in a
  row park it; an outage does not, because an outage is not the event's fault.
- **A job submission reaches the broker before it writes a row.** A consumer
  retries through an outage indefinitely, so a row written ahead of a failed
  publish became one failed job per retry. An unreachable broker now fails the
  submission with nothing written; a key already held is answered without it.
- **One ERP sync of a design at a time**, by a per-design advisory lock. A dedupe
  key per event cannot serialise two releases of one design.

---

**Provenance.** The event bus began as a design spike in September 2026 and was
reframed during review from "an event bus" into **an extensibility platform** —
the log is the foundation, not the headline. It shipped across nine stages in
v0.6.0: the log and its runtime, the emission coverage, operability and
retention, the three-phase dispatch layer, the release path moved onto it, the
catalog growth, webhooks, and the ERP connector's migration from a post-commit
hook to a consumer. Two proposal documents carried the reasoning during
implementation and were deleted when it landed here.

**See also:** [Webhooks](./webhooks.md) ·
[Writing extensions](../development/writing-extensions.md) ·
[Adding a domain event](../development/adding-domain-events.md) ·
[Operating event consumers](../admin/event-consumers.md)
