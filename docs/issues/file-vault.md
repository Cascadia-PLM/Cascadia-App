# Issues: File Vault

Issues discovered during documentation research for the file vault and document control system.

## Metadata extraction is placeholder only

- **Severity**: cosmetic
- **Area**: code
- **Description**: The `extractFileMetadata()` function in `file-utils.ts` contains a TODO noting that PDF metadata extraction (title, author, page count), image EXIF parsing, and CAD property extraction are planned but not implemented. Currently it only returns the file extension and MIME category.
- **Location**: `src/lib/vault/utils/file-utils.ts` lines 282-308
- **Suggestion**: Implement at least PDF page count extraction, which is low-effort with existing libraries and would be useful for document control.

## No duplicate file detection by default

- **Severity**: cosmetic
- **Area**: code
- **Description**: `FileService.uploadFile()` computes a SHA-256 hash for every uploaded file, and has an `allowDuplicates` option that defaults to `true`. The duplicate detection logic exists but is never triggered in practice since the default allows duplicates and no caller sets `allowDuplicates: false`.
- **Location**: `src/lib/vault/services/FileService.ts` lines 139-155
- **Suggestion**: Consider making duplicate detection opt-in via configuration rather than per-call, or surfacing a warning (not a rejection) in the UI when a duplicate hash is detected.

## Azure storage type accepted in config but not implemented

- **Severity**: cosmetic
- **Area**: code
- **Description**: The `StorageConfig` type definition includes `'azure'` as a valid `type` value, but `StorageFactory.create()` throws "Azure storage not yet implemented (Phase 2)" if it is used. This is documented inline but could surprise users who configure `VAULT_TYPE=azure`.
- **Location**: `src/lib/vault/storage/storage-factory.ts` line 82, `src/lib/vault/storage/types.ts` line 65
- **Suggestion**: Either remove `'azure'` from the type union until implemented, or add clearer documentation about supported backends.
