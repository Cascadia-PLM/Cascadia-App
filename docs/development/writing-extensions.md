# Writing Extensions

An extension is code that reacts to what the system does — refusing an operation
before it happens, committing alongside it, or catching up on it durably
afterwards. Handler bodies are TypeScript in a compiled package; enablement and
subscriptions are rows.

This guide is written for a **module author** in this repository, which is what
v0.6.0 delivers. A customer building outside this tree needs three more things —
a supported registration point, a stability promise on the published barrel, and
an answer to the AGPL-linking question — and none of them exists yet. That is
stated here rather than implied, because the surface looks ready and is not.

For the design, see [Extensibility](../features/extensibility.md).

## Choosing a phase

| You want to…                                     | Phase            | Binds to     |
| ------------------------------------------------ | ---------------- | ------------ |
| Refuse an operation, with a reason the user sees | `guard`          | an operation |
| Write something that must commit with the fact   | `in-transaction` | a fact       |
| React durably, with retry and catch-up           | `consumed`       | a fact       |

**Guards bind to operations; the other two bind to facts.** A fact has already
happened, so there is nothing to veto. Guards attach to `item.create`,
`item.update`, `item.delete`, `lifecycle.transition` and `approval.vote`.

Choosing a phase is choosing a failure contract:

| Phase            | On handler failure                                                          |
| ---------------- | --------------------------------------------------------------------------- |
| `guard`          | a refusal reaches the caller as a 422 carrying its reason; a throw is a 500 |
| `in-transaction` | **the whole transaction rolls back**, the fact included                     |
| `consumed`       | recorded on the cursor row, retried with backoff, parked at the threshold   |

If you are unsure, you want `consumed`. `in-transaction` means you are willing to
fail the user's operation when your handler fails.

## A `consumed` extension

```typescript
// packages/your-module/src/lib/your-module/run-alerts.ts
// The published extension surface, which is what a module relies on — not
// the api's internal `lib/extensions` barrel. A module names the application
// packages it reaches; `@/` inside a module is the module itself.
import { defineExtension } from '@cascadia/api/extensions'
import type { ConsumedExtension } from '@cascadia/api/extensions'
import type { WorkOrderRunCompletedPayload } from '@cascadia/api/lib/events'
import { WORK_ORDER_RUN_COMPLETED } from '@cascadia/api/lib/events'
import { PackageRegistry } from '@cascadia/api/lib/packages'

export function createRunAlertsConsumer(): ConsumedExtension<WorkOrderRunCompletedPayload> {
  return {
    id: 'your-module.run-alerts',
    description: 'Notifies quality when a counted run completes',
    phase: 'consumed',
    on: WORK_ORDER_RUN_COMPLETED,
    // Only the events you want, as a declarative filter over the payload's
    // scalar fields. The event type is matched in SQL; `when` is checked as
    // each event is read, and one it rules out is passed over without your
    // handler running.
    when: { countsTowardRequired: true },
    startAt: 'head',
    enabled: () => PackageRegistry.isEnabled('your-module'),
    handler: async ({ event, tx, signal }) => {
      // …using `tx`…
    },
  }
}
```

### `startAt` — declare `'head'` for anything new

```typescript
startAt: 'head',   // everything that already happened counts as delivered
startAt: 'origin', // the default: replay everything still retained
```

**Declare `'head'` for any extension registered after the log shipped.** Without
it, the first run replays the entire retained log: invisible on a fresh install
where the log is empty, and a flood on any database that has been running.

`'head'` is safe rather than merely convenient. The sequencing trigger holds its
lock through COMMIT, so every seq at or below an observed maximum belongs to a
transaction that has fully committed, and no in-flight publisher can later land
below it.

It is consulted **once**, when the cursor row is first created, and never again.

### `enabled` — a predicate, not a captured boolean

```typescript
enabled: () => PackageRegistry.isEnabled('your-module') && isConfigured(),
```

This is the rule most easily got wrong, and the cost of getting it wrong is
invisible.

**Gate here, never inside the handler.** A hook's early return costs nothing. A
consumer's early return _consumes_ the event and advances the cursor — so an
unconfigured instance silently eats its entire backlog, and the day the
credential arrives there is nothing left to process. That defect shipped once in
this codebase and was fixed by moving the gate here.

`enabled` is evaluated **before the transaction opens and before the cursor row
is created**, so a never-enabled extension leaves no cursor and its first enable
starts wherever `startAt` says.

**Prefer the predicate form over a boolean** whenever the answer is not a
compile-time constant. A captured boolean is indistinguishable from a live one
until the day its inputs move, and then it is silently stale: an extension
disabled at boot stays disabled forever after an administrator supplies the
configuration it was waiting for.

**A predicate that throws is answered by phase.** A `consumed` extension runs:
its handler then fails as well, and the failure lands on its cursor row where you
will see it. A `guard` or `in-transaction` extension does not run — a predicate
that cannot say whether it belongs here is no warrant to refuse a user's write or
to join its transaction. The operator's `extensions.disabled` row is different:
a database hiccup reading it fails open in every phase, because a configuration
lookup must never be able to stop a write.

## The `tx`-only rule

**Use `ctx.tx`. Never the module-level `db`.**

A `consumed` handler's writes are wrapped in a per-event savepoint on the run's
transaction, and the cursor advances in that same transaction. A read on `db`
answers from a different snapshot than the cursor you are about to advance; a
write on `db` does not roll back when your handler throws, leaving a side effect
for an event the log still considers undelivered.

This is not enforceable by the compiler — `import { db }` is one line away in a
package the compiler accepts — so it is a rule you keep.

## Idempotency

**Delivery is at-least-once by design.** A run that fails after your handler
succeeded, or a worker that dies before the cursor commits, redelivers the same
event.

For a handler whose effects are all on `tx`, idempotency is free: the savepoint
rolls back with the run, so a redelivery re-does work that was undone.

For a handler that causes an **external** side effect — an HTTP call, a job
submission, a write to another system — it is not free, and you need a durable
dedupe key.

### Submitting a job: name the work

If the side effect is a job, say what the work _is_ and the job system will
submit it once:

```typescript
await JobService.submit(type, payload, userId, {
  dedupeKey: `your-module.your-extension:${event.id}`,
})
```

A job already submitted under that key is **returned rather than queued again**
— no second row, no second broker message, no second execution. Build the key
from what makes the work unique: the event id when one event means one job, plus
a discriminator when one event means several, because two jobs of one event are
different work and must not collapse into each other.

**A key is held by live or finished work.** A job that is pending, queued,
running or completed holds its key. One that failed — its broker publish
included — or was cancelled releases it, so the redelivery that follows a failure
submits the work again rather than being handed the dead job. Retrying a failed
job whose key another job has taken since is refused.

**An outage costs the handler a retry, not a job row.** `submit` connects to the
broker before it writes anything, so while the broker is unreachable it throws a
connection error — which the runtime treats as transient, backing off without
ever parking — and leaves no job behind. A key already held is still answered
with its job, so a redelivery of work queued before the outage goes through
without the broker.

**Why this is a column on the jobs table and not a row you write yourself.** Your
handler runs in a savepoint; `JobService.submit` writes through the module-level
connection. Every way a duplicate arises — your handler throwing after the
submit, or the run transaction failing at COMMIT — rolls back everything _you_
wrote and leaves the job standing. So a dedupe row inside the handler cannot see
the job it is trying to deduplicate against. The key can, because it is on the
row that survived.

### Any other external effect: an intent row

For an effect the job system does not own, you need your own durable key, and the
recipe is:

```typescript
handler: async ({ event, tx }) => {
  // Insert-then-read on the run's transaction. An empty result means a
  // COMMITTED run already handled this event, so do nothing.
  const [intent] = await tx
    .insert(yourIntents)
    .values({ eventId: event.id /* … */ })
    .onConflictDoNothing({ target: yourIntents.eventId })
    .returning({ id: yourIntents.id })

  if (!intent) return

  await doTheExternalThing()
}
```

with a unique key on the event id. The row and the cursor advance together or not
at all.

Know what this does and does not buy. It makes a **committed** run's redelivery a
no-op, which is the case an operator can reach by rewinding a cursor. It does
**not** survive your own handler throwing after the effect, or the run failing at
COMMIT — both roll the intent row back and leave the effect. That is the same
limit described above, and it is why a job uses `dedupeKey` instead: where the
effect's own store can hold the key, put it there.

## The abort signal

`ctx.signal` aborts at the handler deadline (30 s by default,
`handlerTimeoutMs` to change it). Anything that waits on the outside world must
honour it:

```typescript
handler: async ({ event, signal }) => {
  await publish(event.type, event, signal)
}
```

Without it, a deadline bounds the cursor lock but not the call itself: a broker
that accepts a frame and goes quiet holds the lock with nothing to interrupt it.

## No outside world under the cursor lock

The runner holds the cursor row `FOR UPDATE` for the whole run. An HTTP call in
a handler therefore holds it for up to the deadline **per event across a batch**,
and one slow endpoint stalls every event for that consumer.

If you need to reach the outside world, **write a row and let something else
send it.** That is exactly what the webhook dispatcher does: it writes delivery
rows inside the consumer transaction, and a separate pump sends them.

## Registration

Register from your module's **composition root**, not from core:

```typescript
// packages/your-module/src/register.server.ts
export function registerYourModule(): void {
  registerYourModulePackage() // the catalog first — `enabled` reads it
  defineExtension(createRunAlertsConsumer())
}
```

Registration is validated: a duplicate id throws, and re-registering the _same
object_ is a no-op, which is what a re-imported module produces.

Register in the broadest root that runs where your extension must run. The
enterprise worker entry calls both roots, so a consumer registered in the server
root is seen by the worker too — while the reverse is not true, and a consumer
registered only in the worker root sits somewhere its package registration may
not have run.

**Do not put a module file under a path that mirrors a core path under `@/`.**
The boundary checker fails on alias-root collisions, so a module file under
`src/lib/events/` would shadow core's.

## Testing

Use `ConcurrentTestDatabase` for anything that reasons about committed `seq`
values — the sequencing trigger assigns `seq` at COMMIT, and the gate harness
rolls back, so a consumer there sees an empty log. See
[the harness rule](../../packages/cascadia-api/src/__tests__/README.md#choosing-a-harness).

Build the extension **through its options** so external effects are recorded
stubs, and assert on durable rows plus recorded calls — never on a spy's call
shape:

```typescript
const extension = createRunAlertsConsumer({ notify: (p) => { calls.push(p); return … } })
const consumer = asDomainEventConsumer({
  ...extension,
  id: `test.run-alerts-${randomUUID().slice(0, 8)}`,  // per-run, so reruns are clean
  enabled: () => true,
  startAt: 'origin',   // 'head' would seed at the head and process nothing
})
```

Four cases earn their place:

1. **Catch-up** — with the consumer not running, commit three events, then
   drain, and assert all three were handled in seq order.
2. **Failure** — a handler that throws on the second leaves the first handled,
   the cursor at or past the first and short of the second, and the error on the
   row. Assert that range rather than an exact seq: another suite's events can
   commit between yours.
3. **Redelivery** — rewind the cursor, drain again, assert no duplicate effect.
4. **Disabled** — a disabled run creates no cursor, consumes nothing, and does
   not park.

Clean up **by the ids you created**, never by event type: a suite that publishes
real event types would otherwise delete other suites' events out from under them.

---

**See also:** [Extensibility](../features/extensibility.md) ·
[Adding a domain event](./adding-domain-events.md) ·
[Operating event consumers](../admin/event-consumers.md) ·
[Testing](./testing.md)
