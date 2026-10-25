# Owned resource lifetimes

## What this feature is

A lifetime owns allocations and callbacks until its owner ends it. Adapters
receive acquisition authority; only the owner receives disposal authority.
React bindings create one owner per committed input identity or DOM attachment.

## Why you use it

Use it for imperative resources such as model geometry, object URLs, editors,
timers, and their callbacks. It handles partial setup, late asynchronous
acquisition, replacement, and cleanup. Use the existing query layer for cached
server reads; a correctly paired single React effect can remain local.

## Stable entry points

`createOwnedLifetime` and its types come from
`@cascadia/commons/managed-resources`. React owners live in
`@/lifecycle/useOwnedResource`, `@/lifecycle/useOwnedElement`, and
`@/lifecycle/useOwnedEffect`. These hooks own resources, not durable workflows.

## Core mental model

Call `lifetime.acquire(factory, release)` inside an adapter. The factory's return
type determines the resource type and whether acquisition is synchronous or
asynchronous. Cleanup is registered before the resource is handed back. A result
arriving after expiry is released and rejected, so setup cannot continue with a
dead resource. Register each partial acquisition before the next fallible step.

`lifetime.child(onError)` creates independently disposable child authority.
Closing an ancestor disables every descendant's acquisitions and guarded
callbacks before cleanup begins. Child cleanup runs before earlier parent
resources. Released children detach from their parent to avoid retaining old
generations.

## How it executes

`owner.run(setup, publish?, onFailure?)` invokes setup immediately and returns a
promise of `ready`, `expired`, or `failed`. Publication is guarded by the lifetime.
Setup or publication failure ends the owner and releases partial acquisitions.
`ready` means setup succeeded; it does not prove a business operation completed.

`dispose()` closes admission, aborts the owner's signal, and starts finalizers in
reverse registration order. Independent asynchronous cleanup is awaited together;
put dependent cleanup in one finalizer or a child lifetime. Repeated disposal
returns the same promise. Cleanup errors do not skip remaining cleanup and appear
in its report, including errors from live children being closed.

## Small example

```ts
import { createOwnedLifetime } from '@cascadia/commons/managed-resources'

const owner = createOwnedLifetime(console.error)
await owner.run((lifetime) =>
  lifetime.acquire(
    () => new ResizeObserver(lifetime.guard(() => console.log('resized'))),
    (observer) => observer.disconnect(),
  ),
)
await owner.dispose()
```

Guard a vendor callback with `lifetime.guard(callback)` when the vendor can retain
or fire it after disconnection. The callback receives no disposal authority.

## Real example

File preview owns one fetch and its resulting URL per file identity:

```tsx
const input = useMemo(() => ({ id: file.id }), [file.id])
const preview = useOwnedResource(input, async ({ id }, lifetime) => {
  const response = await fetch(`/api/v1/files/${id}/content`, {
    signal: lifetime.signal,
  })
  if (!response.ok) throw new Error('Preview failed')
  const blob = await response.blob()
  return lifetime.acquire(() => URL.createObjectURL(blob), URL.revokeObjectURL)
})
```

The hook derives `idle`, `loading`, `ready`, or `failed`. A null input disables
acquisition. Identity uses `Object.is`, matching React's dependency comparison;
memoize compound inputs explicitly. Callback changes do not restart setup.
Optional `ready` and `failed` observers always see the latest committed callback.

`useOwnedElement(identity, setup, onEvent?)` returns a callback ref. Detachment or
identity replacement ends the old resource, while observer changes preserve it.
Setup receives a guarded, typed `emit` function. This lets CodeMirror keep an
in-progress document while routing edits to the current observer.

## How it relates to other features

CAD loading uses the same acquisition contract for geometry and materials. Its
material-replacement lifetime is a child of the loaded model. The tour uses child
lifetimes for its pending start and active presentation. Tour-local typed progression remains
separate: the tour graph decides which commands may run and which transition
counts as acknowledgement; the resource lifetime cannot decide completion.

## Inspection and debugging

Inspect setup outcomes, cleanup reports, and the React resource state. Distinguish
an expired result from a setup failure. A cleanup report covers registered cleanup
settled during that disposal; later acquisitions still release themselves and
report failures through the diagnostic callback.

## Anti-patterns

Do not use unmount as remote rollback, put a changing observer into resource
identity, retain an unguarded vendor callback, or register cleanup only after
several fallible acquisitions. A finalizer must not await its own owner's disposal.
Shared vendor assets require a per-owner subscription or lease adapter.

## Current limits

Disposal does not wait forever for an uncooperative acquisition. Its late result
is released when it arrives; await the setup outcome when the caller must track
that completion. Cancellation cannot undo effects already performed by a vendor.
Registered asynchronous cleanup has no automatic timeout; process adapters must
declare their own shutdown deadline.

`adopt(resource, release)` is the explicit escape hatch for an already-created
synchronous resource. It still registers cleanup after expiry, but cannot prevent
effects that happened before adoption. Pending promises must use `acquire`.
`onDispose` supports cleanup that cannot be represented by one acquired value.

## Related docs

- [Testing guide](testing.md)
- [Application architecture](../architecture/overview.md)
