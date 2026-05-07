# API Core Issues

Issues identified during API documentation review.

## Inconsistencies

### 1. Default limit inconsistency between endpoints

**Endpoints affected:**

- `/api/v1/items` uses `limit: 100` as default
- `/api/v1/items/search` uses `limit: 50` as default
- `/api/v1/enterprise-search` uses `limit: 50` as default
- `/api/v1/workflows` uses `limit: 100` as default
- `/api/v1/files` uses `limit: 100` as default
- `paginationSchema` defines default as `50`

**Impact:** Clients may get different result counts depending on which endpoint they use, even without specifying a limit. The `paginationSchema` standard is 50, but several endpoints override this.

**Fix:** Consider standardizing on `paginationSchema` defaults (50) for all list endpoints, or document the per-endpoint defaults clearly.

## Missing Features

### 3. No PATCH method support

All update endpoints use PUT, even though the update schemas make all fields optional (PATCH-style). The API uses PUT for partial updates, which is technically not REST-compliant (PUT should replace the entire resource).

**Suggestion:** Consider adding PATCH as an alias, or document that PUT is used for partial updates.
