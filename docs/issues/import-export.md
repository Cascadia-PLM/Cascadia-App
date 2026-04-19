# Import/Export Issues

Issues discovered during documentation review of the import/export system.

---

## 1. Feature list mentions `POST /api/import/parts-bom` but no such endpoint exists

**Severity:** Documentation / Low
**Location:** `cascadia-feature-list.md` line ~366

The feature list states:

> `POST /api/import/parts-bom` -- Parts + BOM relationships together

However, there is no separate `parts-bom` endpoint. BOM relationships are handled by the existing `POST /api/import/parts` endpoint via the optional `bomRelationships` field in the request body (using `importPartsWithBomRequestSchema`).

**Recommendation:** Update `cascadia-feature-list.md` to reflect that `POST /api/import/parts` handles both parts-only and parts-with-BOM imports.

---

## 2. CSV parser does not handle multiline quoted fields

**Severity:** Low
**Location:** `src/lib/import/parser.ts` lines 203-249

The CSV parser splits input on `\r?\n` first, then processes each line individually. This means quoted fields that span multiple lines (which RFC 4180 allows) will be incorrectly split across multiple rows. For example:

```csv
Name,Description
"Widget","This widget has a
multiline description"
```

This would be parsed as two separate rows instead of one row with a multiline description.

**Recommendation:** Refactor the CSV parser to operate on the full text as a stream rather than splitting into lines first. Alternatively, document this as a known limitation.

---

## 3. File clear in FileUploadStep uses `window.location.reload()`

**Severity:** Low (UX)
**Location:** `src/components/import/steps/FileUploadStep.tsx` line 222

The clear button handler contains a `window.location.reload()` call with the comment "Temporary - should properly clear state." This causes a full page reload when the user wants to remove an uploaded file and try another.

**Recommendation:** Pass a proper `onClear` callback from the parent `ImportDialog` to reset the file and mapping state without reloading the page.

---

## 4. Template download endpoints always return CSV regardless of `format` parameter

**Severity:** Low
**Location:** `src/routes/api/import/templates/parts.ts`, `documents.ts`, `issues.ts`

All three template endpoints accept a `format` query parameter but contain a comment "For XLSX, we would need to use xlsx library" and fall through to returning CSV in all cases.

**Recommendation:** Either implement XLSX template generation or remove the `format` parameter to avoid misleading API consumers.

---

## 5. `PART_FIELDS` is defined in two places

**Severity:** Low (maintenance)
**Location:** `src/lib/import/constants.ts` and `src/lib/import/field-configs/part-fields.ts`

Both files define identical `PART_FIELDS` and `BOM_FIELDS` arrays. The `constants.ts` version is marked with `@deprecated` comments pointing to the field-configs module, but it is still exported and used as the primary import source for template endpoints and backward compatibility.

**Recommendation:** Complete the migration by removing the duplicate definitions from `constants.ts` and updating all imports to use `field-configs/part-fields.ts`.
