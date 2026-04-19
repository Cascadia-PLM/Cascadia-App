# Issues: Programs and Designs

Issues discovered during documentation review of the programs and designs feature area.

---

## 1. ProgramService.listAll() does in-memory pagination

**Severity:** Low
**File:** `src/lib/services/ProgramService.ts` (lines 194-207)

The `listAll()` method fetches all programs from the database and then slices the result in memory for pagination. For large deployments with many programs, this is inefficient. The `search()` method already does proper database-level pagination with `LIMIT`/`OFFSET` -- consider deprecating `listAll()` in favor of `search()`, or adding `.limit()` and `.offset()` to the query builder.

The same issue exists in `DesignService.listAll()` (lines 363-386) and `DesignService.listWithHierarchy()` (lines 1082-1084).

---

## 2. ProgramService.update() does not prevent updating a Completed/Cancelled program

**Severity:** Low
**File:** `src/lib/services/ProgramService.ts` (lines 143-177)

There is no guard preventing updates to programs in `Completed` or `Cancelled` status. Depending on business rules, it may be desirable to lock programs in terminal states. Currently any admin can freely update them. This may be intentional, but it is worth documenting the intended behavior.

---

## 3. Design DELETE endpoint calls archive() but is not clearly documented as soft delete

**Severity:** Informational
**File:** `src/routes/api/designs/$id.ts` (line 64)

The `DELETE /api/designs/:id` endpoint calls `DesignService.archive()` which sets `isArchived=true` rather than actually deleting the design. This is correct behavior (soft delete) but may surprise API consumers who expect DELETE to be destructive. The API response (`{ success: true }`) does not indicate that this was an archive operation.

---

## 4. DesignService.update() accepts \_userId parameter but does not use it

**Severity:** Low
**File:** `src/lib/services/DesignService.ts` (line 305)

The `update()` method accepts `_userId` as a parameter (prefixed with underscore indicating unused) but does not set `updatedBy` or any audit field with it. The `set()` call only sets `updatedAt`. The designs table does not have an `updatedBy` column, unlike the programs table which does. This is an inconsistency -- either add `updatedBy` to the designs table or remove the unused parameter.

---

## 5. Cross-design reference unique constraint allows duplicates across branches

**Severity:** Low
**File:** `src/lib/db/schema/crossReferences.ts` (lines 72-76)

The unique constraint is on `(referencingDesignId, referencedItemId, branchId)`. Since `branchId` is nullable, a baseline reference (`branchId=NULL`) and a branch-specific reference (`branchId=<uuid>`) for the same item can coexist. This is by design for the branch-tracking pattern. However, the `removeReference()` method inserts a `deleted` marker using `onConflictDoNothing()`, which means if a `deleted` marker already exists for the same item on the same branch, the second removal is silently ignored. This is safe but could mask bugs if the same reference is removed twice in different code paths.

---

## 7. Program history graph endpoint is large and has duplicated consolidation logic

**Severity:** Low
**File:** `src/routes/api/programs/$id/history/graph.ts`

The commit consolidation logic (time-window grouping, importance detection, message summarization) is duplicated between the program graph and design graph endpoints. A comment on line 22 acknowledges this ("shared from design graph"). Consider extracting the shared consolidation functions into a common utility.
