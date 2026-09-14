# Operating Event Consumers

Cascadia records business facts in a durable log, and **consumers** read that log
to do work: stamping superseded drawings, alerting on changed work
instructions, delivering webhooks, syncing an ERP. Each consumer keeps its own
position in the log — its **cursor** — so a consumer that stops falls behind
rather than losing anything.

The panel is at **Admin → Domain Events** (`/admin/events`), and needs
`system:manage`.

## Reading the panel

| Column       | What it means                                                                    |
| ------------ | -------------------------------------------------------------------------------- |
| **Lag**      | How many events this consumer has not yet handled. Zero is current.              |
| **Cursor**   | Its position, against the head of the log.                                       |
| **Failures** | Consecutive failed runs. Click it to see the error and the event it is stuck on. |
| **Poller**   | Whether _this_ process polls it — see below.                                     |

### States

| State         | Meaning                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **current**   | Nothing outstanding.                                                                                                        |
| **behind**    | Has a backlog and is working through it. Normal after an outage or a large release.                                         |
| **retrying**  | A handler failed; it is backing off and will try again by itself. **No action needed.**                                     |
| **parked**    | Failed repeatedly and has stopped trying. It will not resume on its own. Its backlog is intact.                             |
| **abandoned** | Parked so long that retention gave up waiting. **Its backlog is forfeit.** It cannot be resumed or skipped, only forgotten. |

A **retrying** consumer that failed on infrastructure — a refused or dropped
connection, the database restarting, the broker unreachable — backs off like any
other but never parks for it. An outage costs latency, not an action.

## `registeredHere: false` is normal, not a fault

The **Poller** column says whether the process serving the page registers that
consumer. Each process polls the consumers it registers: the app server polls
core's release extensions by default (`EVENT_CONSUMERS_IN_APP`), while the
RabbitMQ relay and the webhook dispatcher run only in the **jobs worker**. So on
the app's page those two read `elsewhere`, and that is the expected reading.

What actually says "nothing is draining this anywhere" is **lag that grows while
Last progress stays stale**. Those two columns sit next to each other for that
reason. If you see it:

- Check the jobs worker is running.
- Check `EVENT_CONSUMERS_IN_APP` — if it is `false` and no worker is deployed,
  nothing polls at all.

## Lag that is growing

Ordinary causes, in the order worth checking:

1. **The worker is down.** Lag grows, Last progress is stale, nothing is parked.
2. **A consumer is parked.** Its own lag grows; everything else is current.
3. **A genuinely large release.** Lag spikes and drains within minutes. Watch it
   for one poll interval before acting.

Lag is not itself an error. A consumer that is behind and catching up is the
system working as designed.

## Resume, skip, forget

Three actions, and two of them permanently lose something. Read this before
using either.

### Resume — safe

Clears the failure count, the backoff and the parked flag. The consumer retries
the **same event** on its next run.

Use it when you have fixed the cause: restarted the ERP, corrected the
configuration, deployed the fix. If the cause is still there, it parks again,
which costs nothing.

Resume is refused for an **abandoned** consumer: retention may already have
pruned its backlog, so resuming would silently pass over whatever was deleted.
Forget its cursor instead.

### Skip — loses one event, deliberately

Advances the cursor **past** the event it is failing on, and clears the failure.

**That event is never handled by this consumer.** Nothing retries it and nothing
records what it would have done. Use it only for a genuinely poisonous event —
one that will fail forever whatever you do — and note the seq first, so you know
what was lost. Skip is refused for an abandoned consumer, for the same reason as
resume.

> **Skipping on the webhook dispatcher drops the event for every subscription at
> once.** It is one consumer serving all of them.

### Forget — loses the whole backlog

Deletes the cursor row.

**This abandons everything that consumer has not handled**, exactly as skip does
but for all of it. A consumer re-registered afterwards restarts wherever its code
declares — for most, that means treating everything currently in the log as
already delivered.

It exists because neither resume nor skip removes a cursor, and a cursor nobody
owns **pins retention forever** (below). Use it for a consumer no process owns
any more — an ERP consumer on an instance that dropped the package, a webhook
dispatcher on one that abandoned webhooks — not to unstick a working one.

## Why a parked cursor pins retention

Retention deletes an event only when it is **older than the retention window
_and_ every consumer has already passed it**. A parked consumer is still owed its
backlog, so its cursor holds the floor where it is, and the log keeps growing
while the prune job reports success on every run.

Orphan cursors count too — a cursor for a consumer no process currently
registers still holds the floor, because a pruning process can only see its own
registry and another process in the fleet may still own that consumer.

The escape is the **give-up horizon**. A consumer parked for longer than
`EVENT_RETENTION_DAYS` is excluded from the floor and marked **abandoned**: by
then the events from when it parked are old enough to prune, so waiting longer
only grows the log. Its backlog becomes forfeit, it cannot be resumed or skipped,
and the exclusion is reported by the prune job and shown on the panel rather than
happening quietly. Forget its cursor and it starts again wherever its code
declares.

A consumer that is registered but has **never run** — a worker that is down, an
extension not yet enabled — has no cursor, and so holds no floor: events older
than the window can be pruned before its first run. That is what an `origin`
consumer promises anyway, replaying what is still retained rather than
everything ever written.

So: **a parked consumer is not a thing to leave parked.** Fix it, skip past the
poison, or forget it — but decide.

## Retention

| Variable                          | Default | Meaning                                                   |
| --------------------------------- | ------- | --------------------------------------------------------- |
| `EVENT_RETENTION_DAYS`            | `90`    | Days of event history kept. Zero or less retains forever. |
| `WEBHOOK_DELIVERY_RETENTION_DAYS` | `30`    | Days of webhook delivery history kept.                    |

Both are pruned by the `maintenance.events.prune` job on the maintenance sweep.
A **pending** webhook delivery is never pruned whatever its age — expiry is the
delivery pump's decision and carries its own reason — except a deleted
subscription's, which nothing would ever send: those are expired, with that
reason, and pruned like any other settled delivery.

If events are not being pruned, the prune job's result says why: it reports the
horizon it computed, which consumers hold it there (`pinnedBy`), which cursors
it excluded as abandoned, and how many rows carry no seq at all. A non-zero unsequenced count means the sequencing trigger is
missing and **nothing is being consumed** — see below.

## Nothing is being consumed at all

If every consumer's lag is growing and none of them has ever made progress, check
that the sequencing trigger exists. Events with a null `seq` are invisible to
every consumer.

Every emitting and consuming process ensures the trigger at boot, so the usual
cause is that nothing has started since the database was provisioned. Restart the
app or the worker; a restart also gives every row written before the trigger
existed its seq, so nothing recorded in the meantime is lost. `db:check-migrations` asserts the trigger's presence in CI, so
a missing one in production means the database was provisioned by something other
than the committed migrations.

---

**See also:** [Extensibility](../features/extensibility.md) ·
[Webhooks](../features/webhooks.md) ·
[Configuration](../orchestration/configuration.md)
