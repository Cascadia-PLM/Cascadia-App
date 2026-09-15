# Adding a Domain Event

A domain event is a **business fact**, written in the same transaction as the
change it describes. Adding one means defining its payload contract, registering
it so the catalog can see it, and emitting it from inside the caller's
transaction.

For reacting to events, see
[Writing Extensions](./writing-extensions.md). For the design, see
[Extensibility](../features/extensibility.md).

```
  your service method
        │
        ├─ db.transaction(async (tx) => {
        │      …the writes that make the fact true…
        │      await publishDomainEvent(tx, YOUR_EVENT, { payload })
        │  })                            ▲
        │                                └── the SAME tx. Not `db`.
        │
        └─ COMMIT ── deferred trigger assigns seq
                     └─ the event exists iff the change committed
```

The walkthrough below adds a hypothetical `work_order.scrapped`. It is not in the
shipped catalog, so follow the steps with your own event rather than importing
it.

## 1. Define the payload schema and the definition

`packages/cascadia-api/src/lib/events/definitions/work-orders.ts`

```typescript
import { z } from 'zod'
import { defineDomainEvent } from '../registry'

export const workOrderScrappedPayloadSchema = z.object({
  workOrderId: z.string().uuid(),
  workOrderNumber: z.string(),
  /** The physical unit scrapped, not the part it was built from. */
  physicalPartId: z.string().uuid(),
  /**
   * Whether this scrap consumed the work order's last remaining unit — a flag,
   * not a status string, so a consumer never has to know which of six statuses
   * mean "finished" and does not break when a seventh appears.
   */
  completesWorkOrder: z.boolean(),
})

export type WorkOrderScrappedPayload = z.infer<
  typeof workOrderScrappedPayloadSchema
>

/**
 * A physical unit was scrapped against a work order.
 *
 * Emitted inside the transaction that records the scrap, so the fact exists if
 * and only if the scrap committed.
 */
export const WORK_ORDER_SCRAPPED = defineDomainEvent({
  type: 'work_order.scrapped',
  schemaVersion: 1,
  description: 'A physical unit was scrapped against a work order',
  subjectType: 'work_order',
  payloadSchema: workOrderScrappedPayloadSchema,
})
```

**Naming.** `<entity>.<past_tense_fact>`, lower snake case. It is a record of
something that happened, so `scrapped`, never `scrap`.

**Payloads point rather than snapshot.** Carry ids, plus the few fields a
consumer could not reconstruct — a human-facing label that must be the one that
was true _then_, or a flag derived from logic a consumer should not reimplement.
Do not copy the row: a snapshot is stale the moment it is written.

## 2. Register it in three places

Missing the third leaves the type **silently absent** from the catalog API and
from every wildcard consumer — including webhooks — with nothing failing.

```typescript
// packages/cascadia-api/src/lib/events/definitions/work-orders.ts
// (1) `defineDomainEvent` self-registers. Done in step 1.

// packages/cascadia-api/src/lib/events/definitions/register.ts
// (2) The side-effect import. If the file is new, add it here.
import './work-orders'

// packages/cascadia-api/src/lib/events/index.ts
// (3) Re-export the definition and its payload type, so callers and extension
//     authors can reach both without importing a definitions file directly.
export { WORK_ORDER_SCRAPPED } from './definitions/work-orders'
export type { WorkOrderScrappedPayload } from './definitions/work-orders'
```

A **module-owned** definition registers from the module's composition root
instead — never from core's `register.ts`.

## 3. Emit inside the caller's transaction

`packages/cascadia-api/src/lib/services/WorkOrderService.ts`

```typescript
import { publishDomainEvent, WORK_ORDER_SCRAPPED } from '@/lib/events'

static async scrapUnit(input: ScrapInput, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const workOrder = await tx.update(workOrders) /* … */
    await tx.insert(scrapRecords).values(/* … */)

    await publishDomainEvent(tx, WORK_ORDER_SCRAPPED, {
      payload: {
        workOrderId: workOrder.id,
        workOrderNumber: workOrder.itemNumber,
        physicalPartId: input.physicalPartId,
        completesWorkOrder: remaining === 0,
      },
      actorId: userId,
      subject: { type: 'work_order', id: workOrder.id },
      context: { designId: workOrder.designId },
    })
  })
}
```

> **The first argument is a transaction the caller already holds.** Passing the
> module-level `db` is the one mistake this design cannot survive: the event
> would commit separately from the change it claims to describe, so a rollback
> leaves a fact asserting something that never happened, and a crash between the
> two leaves the change with no fact. Everything downstream — ordering,
> catch-up, the webhook guarantee — rests on the event and the change sharing one
> transaction.

If the write path is not transactional yet, **wrap it** rather than emitting
outside one. Several stage-6 event types needed exactly that, and the wrap was
the real work.

## 4. Write a consumer, if something should react

See [Writing Extensions](./writing-extensions.md). The short version:

```typescript
defineExtension({
  id: 'core.scrap-notifications',
  phase: 'consumed',
  on: WORK_ORDER_SCRAPPED,
  startAt: 'head',
  handler: async ({ event, tx }) => {
    if (!event.payload.completesWorkOrder) return
    // …using `tx`, never `db`…
  },
})
```

## Rules that are not visible in the code

**Handlers must be idempotent.** Delivery is at-least-once by design.

**Handlers must honour the abort signal** (`ctx.signal`), which fires at the
handler deadline.

**Handlers must never reach the outside world under the cursor lock.** The runner
holds the consumer's cursor row `FOR UPDATE` for the whole run. An HTTP call in a
handler holds it for up to the deadline per event across a batch, and one bad
endpoint then stalls every event for that consumer.

**Nothing is ever skipped automatically.** A failing handler stops its consumer.
An operator resumes or skips deliberately, and a skip is recorded — see
[Operating event consumers](../admin/event-consumers.md).

**Flags, never state names.** `completesWorkOrder`, not `status: 'closed'`.

**No event for a write that changed nothing.** An update that computed no
difference is not a fact. Compare before emitting.

**Emit once per fact, at the right granularity.** One `design.released` per
design, not one per item and not one per change order — the granularity a
consumer needs is the granularity at which failure should be isolated.

## Testing

A test that reasons about committed `seq` values needs
`ConcurrentTestDatabase`, not `TestDatabase`: the sequencing trigger assigns
`seq` at COMMIT, and the gate harness rolls back. See
[the harness rule](../../packages/cascadia-api/src/__tests__/README.md#choosing-a-harness).

The emission test that earns its place is usually the **negative** one — that a
path which should be silent stays silent. "A working-copy mint produces zero
relationship events" is what stops a later refactor turning every checkout into a
BOM storm.

---

**See also:** [Extensibility](../features/extensibility.md) ·
[Writing extensions](./writing-extensions.md) ·
[Background jobs](./adding-background-jobs.md)
