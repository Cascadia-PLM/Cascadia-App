# BOM Management -- Issues Found During Documentation Review

## Issue 1: Unreachable Code in BOM Changes Endpoint

**File**: `src/routes/api/change-orders/$id/bom-changes.ts`, line 148

**Description**: The `throw new ValidationError('Invalid action')` on line 148 is unreachable code. The `action` field is validated by Zod as `z.enum(['add', 'remove', 'modify'])`, and the if/else-if/else chain on lines 84-146 covers all three cases exhaustively (the final `else` handles 'modify'). The throw can never be reached.

**Severity**: Low (no runtime impact, but misleading to readers)

**Suggested fix**: Remove the unreachable throw statement.

---

## Issue 2: removeRelationship Deletes Before Checking Existence

**File**: `src/lib/items/services/ItemRelationshipService.ts`, lines 296-300

**Description**: In `removeRelationship()`, the DELETE query executes first (line 297-299), and then the code checks if the relationship existed (line 300: `if (relationshipResults.length === 0) return`). The `relationshipResults` were fetched before the delete on lines 292-296, but the ordering in the code reads confusingly -- the select happens before the delete, which is correct, but there is no error thrown if the relationship does not exist. The caller has no way to know if a relationship was actually deleted or if it was already gone.

**Severity**: Low (the behavior is silent success, which is acceptable for idempotent deletes, but could mask bugs)

---
