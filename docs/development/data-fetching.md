# Data Fetching

One cache, one set of keys, one place that decides what a mutation invalidates.

Everything the UI reads goes through the shared TanStack Query cache in
`packages/core/src/lib/query/`. Route loaders prime it, components read it, mutations
invalidate it. There is no second cache.

## Why it works this way

The app previously ran two caches side by side. Route loaders fetched into
TanStack Router's loader cache; components fetched the _same_ endpoints into
TanStack Query's cache under ad-hoc keys; a third of the app skipped both and
fetched in `useEffect`. A mutation refreshed at most one of them, so creating
a Design and landing on the Designs list showed the pre-create rows until a
manual browser refresh.

Collapsing them onto one cache is what makes invalidation meaningful:
invalidating `designs` now reaches the list grid, the detail page, the program
sidebar, and every picker, whether or not they are currently mounted.

## The layers

| File                                          | Owns                                            |
| --------------------------------------------- | ----------------------------------------------- |
| `packages/core/src/lib/query/client.ts`       | The single `QueryClient` and its defaults       |
| `packages/core/src/lib/query/keys.ts`         | `qk` — every cache key in the app               |
| `packages/core/src/lib/query/invalidation.ts` | Which resources go stale when one is written    |
| `packages/core/src/lib/query/hooks.ts`        | `useInvalidateResources`, `useResourceMutation` |
| `packages/core/src/lib/query/grid-params.ts`  | URL ⇄ grid params, shared by loaders and grids  |
| `packages/core/src/lib/query/options/*`       | Query factories per resource                    |

Import from the barrel: `import { designListQuery, useInvalidateResources } from '@/lib/query'`.

## Keys

Keys are hierarchical, because `invalidateQueries` matches by **prefix**:

```
['designs']                        every design query
['designs', 'list', params]        one list variant
['designs', 'detail', id]          one design
['designs', 'detail', id, 'tags']  a sub-collection of one design
```

Never write a key inline. Build it with `qk` so a prefix invalidation can
reach it:

```ts
qk.all('designs') // ['designs']
qk.list('designs', { programId }) // ['designs', 'list', { programId }]
qk.detail('designs', id) // ['designs', 'detail', id]
qk.sub('designs', id, 'branches') // ['designs', 'detail', id, 'branches']
qk.collection('designs', 'families') // ['designs', 'families']
```

## Reading: route loaders

A loader's job is to _prime the cache_, not to return data. It calls
`ensureQueryData` on the same query factory the component reads, so the
component renders from cache with no second request.

```ts
export const Route = createFileRoute('/designs/')({
  validateSearch: designsSearchSchema,
  // Pass the whole search object so the loader derives the same grid params
  // the component will — same params, same key, one fetch.
  loaderDeps: ({ search }) => search,
  loader: async ({ context: { queryClient }, deps }) => {
    const grid = gridParamsFromSearch(deps)
    await Promise.all([
      queryClient.ensureQueryData(designGridQuery(grid, deps.programId)),
      queryClient.ensureQueryData(designCountsQuery(deps.programId)),
    ])
  },
})
```

`queryClient` comes from router context, wired in `src/router.tsx`.

Do **not** return data from the loader and read it with `useLoaderData()`.
That reintroduces the second cache: `invalidateQueries` cannot reach it, and
`router.invalidate()` alone will not refetch it once the query is fresh.

## Reading: components

Components read the same factory with `useQuery`:

```ts
const { data: programs = [] } = useQuery(programListQuery())
```

Because the loader already awaited it, this resolves from cache on first
render — no loading flash. On invalidation it refetches in the background.

For a paged table, use `useServerDataGrid` with the same factory:

```ts
const { items, total, dataGridProps } = useServerDataGrid<Design>({
  query: (grid) => designGridQuery(grid, searchParams.programId),
})
```

## Writing: `useResourceMutation`

**New mutation code uses `useResourceMutation`.** It is the standard for
anything that writes:

```ts
const archive = useResourceMutation({
  mutationFn: (id: string) =>
    apiFetch(`/api/v1/designs/${id}/archive`, { method: 'POST' }),
  invalidates: ['designs'],
  onSuccess: () => {
    showSuccess('Design archived')
    navigate({ to: '/designs' })
  },
})

// in a handler:
archive.mutate(design.id)
```

Three things it gives you that the hand-rolled shape does not:

- **Ordering.** `invalidates` is registered _before_ `onSuccess` runs, so a
  navigation performed there lands on a page that is already refetching. Write
  it by hand and the invalidate/navigate order is a coin flip that only shows
  up as a stale flash on a slow connection.
- **`invalidates: ReadonlyArray<Resource>` is typed.** A resource that does not
  exist is a compile error, not an invalidation that silently reaches nothing.
- **`isPending` for free**, instead of a `useState(false)` and a `try/finally`
  that has to be right on every path.

### The hand-rolled shape, and when it is still fine

Most of the app predates the hook and writes this instead:

```ts
const invalidate = useInvalidateResources()

await apiFetch('/api/v1/designs', { method: 'POST', body })
showSuccess('Design created', `${data.code} has been created`)
await invalidate('designs')
```

This is **not broken** — `useInvalidateResources` invalidates the query cache
_and_ re-runs the active route loaders, and both matter: the first is what
makes an unmounted page refetch when you next navigate to it, the second
rebuilds the current page. There is no sweep planned to convert the hundreds
of existing call sites; a mechanical rewrite of working code is all churn and
no signal.

The rule is **refactor-on-touch**: a PR that rewrites a mutation handler moves
it to the hook. A PR that merely reads one leaves it alone.

Enforcement is review and convention, not lint. A rule banning `apiFetch` with
a write method outside `useResourceMutation` has too many legitimate exceptions
— file uploads, SSE, anything reading a raw `Response` — to land at zero
warnings.

### You do not list every affected resource

`RESOURCE_DEPENDENTS` in `invalidation.ts` encodes the overlaps, and edges are
followed transitively. Naming `parts` also refreshes `items` (a Part is a row
there too), which in turn refreshes `dashboard`, `enterprise-search`, `thread`
and `sysml`. Name the resource you wrote; the graph handles the rest.

When you add an endpoint that exposes existing data through a new shape, add
the edge to that map rather than to the call sites.

## Anti-patterns

These are the five idioms this layer replaced. None of them should come back.

**`router.invalidate()` on its own.** Re-runs loaders, but loaders read
through `ensureQueryData` — if the query is still fresh, nothing refetches.
Use `useInvalidateResources()`, which does both.

**`refetch()` after a mutation.** Refreshes the one grid you are looking at
and nothing else — the detail page, the sidebar, and the counts stay stale.
`refetch()` is for genuinely local refreshes only.

**`useEffect` + `fetch` + `useState`.** A private cache nothing can
invalidate. Use `useQuery` with a factory from `options/`.

This one is now enforced by lint: `fetch`/`apiFetch` inside a `useEffect` in
`components/` or `routes/` is an ESLint error (`no-restricted-syntax` in
`eslint.config.js`). The files that predate the rule are pinned in a legacy
allowlist directly below it, which the conversion batches (FE-3..FE-6) drain —
files may only ever be _removed_ from that list. A fetch inside a `useCallback`
that an effect merely invokes is not matched by the selector; those go out with
the same conversions.

**Local-state surgery** (`setRows(rows.filter(r => r.id !== id))` after a
delete). Hides staleness on one screen and diverges from the server. Delete
the row on the server and invalidate.

**Manual refresh counters** (`setRefreshTrigger(n => n + 1)` as a `useEffect`
dependency). A hand-rolled invalidation that only reaches one component.

## Defaults, and why

Set in `client.ts`:

- `staleTime: 30_000` — navigation between pages does not refetch on every
  hop. Correctness after _your own_ writes comes from invalidation, not from
  this window.
- `refetchOnWindowFocus: true` — a PLM is multi-user; returning to the tab
  should show current data. Cheap, since a query inside `staleTime` is a no-op.
- `retry: false` — `apiFetch` already retries retryable failures with
  exponential backoff. Retrying here too would multiply attempts and stack the
  delays.

## Adding a resource

1. Add a query factory in `packages/core/src/lib/query/options/<resource>.ts` using `qk`
   for the key. For a simple `GET /api/v1/x/:id`, `entityQuery` already covers
   it; for `GET /api/v1/x`, `collectionQuery` does.
2. Export it from `packages/core/src/lib/query/index.ts`.
3. If writing it should refresh other resources, add the edge to
   `RESOURCE_DEPENDENTS`.
4. Prime it from the route loader with `ensureQueryData`; read it with
   `useQuery`; invalidate it after mutations.
