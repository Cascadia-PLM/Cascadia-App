# File Vault and Document Control

The file vault is Cascadia's enterprise file management system. It provides PDM-style (Product Data Management) check-in/check-out, automatic versioning, branch-aware storage, and pluggable storage backends. Every file attached to an item -- CAD models, drawings, specifications, analysis reports -- flows through the vault.

---

## Table of Contents

- [Overview](#overview)
- [File Upload and Download](#file-upload-and-download)
  - [Uploading Files](#uploading-files)
  - [Downloading Files](#downloading-files)
  - [Batch Uploads](#batch-uploads)
- [Check-Out for Edit](#check-out-for-edit)
- [Check-In with Versioning](#check-in-with-versioning)
- [Discard Checkout](#discard-checkout)
- [Lock Status](#lock-status)
- [Lock Hierarchy](#lock-hierarchy)
- [Primary File Designation](#primary-file-designation)
- [Multiple Files Per Item](#multiple-files-per-item)
- [File Metadata](#file-metadata)
  - [File Categories](#file-categories)
  - [CAD Metadata](#cad-metadata)
  - [Audit History](#audit-history)
- [Branch-Aware Storage](#branch-aware-storage)
- [File Promotion on Merge](#file-promotion-on-merge)
- [Storage Abstraction](#storage-abstraction)
  - [Local Filesystem](#local-filesystem)
  - [S3-Compatible Storage](#s3-compatible-storage)
  - [Configuration Priority](#configuration-priority)
- [API Reference](#api-reference)
- [Key Files](#key-files)

---

## Overview

In traditional Product Lifecycle Management systems, files are not stored as loose attachments. Instead, they live inside a _vault_ -- a controlled storage system that enforces who can read, modify, and release files. This prevents the chaos of shared network drives where anyone can overwrite a CAD model without tracking who changed what.

Cascadia's vault provides:

- **Check-out/check-in** -- Before editing a file, a user must check it out, which locks it. Other users can still download and view the file, but they cannot modify it until it is checked back in.
- **Automatic versioning** -- Each check-in with a new file creates a new version. All previous versions are preserved and downloadable.
- **Branch isolation** -- Files uploaded on an ECO branch are invisible to users viewing the item on the main branch, until the ECO is released.
- **File integrity** -- Every file is hashed (SHA-256) on upload and verified against storage to detect corruption.
- **Soft delete** -- Deleted files are recoverable. Permanent deletion is a separate admin-only operation.
- **Storage abstraction** -- The vault can store files on the local filesystem or in any S3-compatible object store (AWS S3, MinIO, DigitalOcean Spaces, etc.).

The vault is implemented primarily in `src/lib/vault/`, with the `FileService` class providing the service layer and the `VaultStorage` interface abstracting the storage backend.

---

## File Upload and Download

### Uploading Files

Files are attached to items (Parts, Documents, Change Orders, etc.) via multipart form upload. The upload route is:

```
POST /api/items/{itemId}/files/upload
Content-Type: multipart/form-data
```

The form data accepts:

| Field                   | Type   | Required | Description                            |
| ----------------------- | ------ | -------- | -------------------------------------- |
| `file_0`, `file_1`, ... | File   | Yes      | One or more files to upload            |
| `branchId`              | string | No       | Branch context for version isolation   |
| `file_0_description`    | string | No       | Description for the corresponding file |

On upload, the vault performs these steps:

1. **Size validation** -- Rejects files exceeding the maximum size (default: 100 MB per file, configurable up to 500 MB in the UI).
2. **Type validation** -- Only PLM-relevant file types are accepted. The system uses an allowlist of extensions including CAD formats (`.step`, `.stp`, `.stl`, `.sldprt`, `.catpart`, etc.), documents (`.pdf`, `.docx`, `.xlsx`), images (`.png`, `.jpg`), archives (`.zip`), and data files (`.json`, `.xml`, `.yaml`).
3. **SHA-256 hashing** -- A content hash is computed for integrity verification and optional duplicate detection.
4. **Filename sanitization** -- Dangerous characters are stripped; only alphanumeric characters, dashes, underscores, and spaces are preserved. Filenames are truncated to 200 characters.
5. **Storage path generation** -- Files are stored under a structured path: `/{masterId}/{revision}/{fileId}/{version}/{sanitizedFilename}`.
6. **Category detection** -- The system automatically categorizes the file based on its extension and filename (see [File Categories](#file-categories)).
7. **Primary model auto-assignment** -- If this is the first CAD model uploaded to an item, it is automatically marked as the primary model.
8. **Integrity verification** -- After writing to storage, the file size is read back and compared. If the sizes differ, the file is deleted and an error is returned.
9. **Commit tracking** -- If the item belongs to a design, a commit record is created documenting the file attachment.

**Example: Upload a file via the API**

```bash
curl -X POST "http://localhost:3000/api/items/{itemId}/files/upload" \
  -H "Cookie: session=..." \
  -F "file_0=@bracket.step" \
  -F "branchId=eco-branch-uuid"
```

**Response (201 Created):**

```json
{
  "success": true,
  "files": [
    {
      "id": "file-uuid",
      "itemId": "item-uuid",
      "branchId": "eco-branch-uuid",
      "fileName": "bracket.step",
      "originalFileName": "bracket.step",
      "fileSize": 245760,
      "mimeType": "application/octet-stream",
      "fileHash": "a1b2c3...",
      "fileVersion": 1,
      "isLatestVersion": true,
      "isCheckedOut": false,
      "fileCategory": "cad_model",
      "isPrimaryModel": true
    }
  ],
  "count": 1
}
```

### Downloading Files

Files are downloaded via streaming or buffered response depending on size:

```
GET /api/files/{fileId}/download
```

- Files smaller than 10 MB are returned as a complete buffer.
- Files larger than 10 MB are streamed to avoid memory pressure.

The response includes proper headers for browser download behavior:

```
Content-Type: application/step
Content-Disposition: attachment; filename="bracket.step"
Content-Length: 245760
X-Content-Type-Options: nosniff
```

Design-level access control is enforced: the system checks that the requesting user has access to the design that owns the item.

### Batch Uploads

The upload endpoint accepts multiple files in a single request. Each file in the form data is processed sequentially, and all resulting file records are returned together.

---

## Check-Out for Edit

Checking out a file is the vault's mechanism for exclusive editing. When a user checks out a file, it is locked -- no other user can check out or modify that file until the original user checks it back in.

**Why is this needed?** In engineering workflows, two people editing the same CAD model simultaneously leads to lost work. Unlike text files that can be merged, binary CAD files cannot. Check-out prevents this by ensuring only one person edits at a time.

```
POST /api/files/{fileId}/checkout
```

**What happens on checkout:**

1. The system verifies the file exists and is not deleted.
2. If the file is already checked out (by any user), the request fails with an error identifying the current holder.
3. The file record is updated with `isCheckedOut = true`, the user's ID, and a timestamp.
4. The action is logged to the file history.

**Batch checkout** is available for workflows where multiple files need to be locked simultaneously (common in CAD assembly editing):

```
POST /api/files/batch-checkout
{ "fileIds": ["file-uuid-1", "file-uuid-2", ...] }
```

Batch checkout processes each file individually, returning a combined result with both successes and failures. The response uses HTTP status codes:

- **201** -- All files checked out successfully
- **207 Multi-Status** -- Some succeeded, some failed
- **400** -- All failed

The batch limit is 100 files per request.

---

## Check-In with Versioning

Checking in a file releases the lock. Optionally, the user can upload a new version of the file at the same time.

```
POST /api/files/{fileId}/checkin
```

There are two modes:

### Check-in without new version (unlock only)

Send the request with no body or a JSON body. The file is unlocked (`isCheckedOut = false`, `checkedOutBy = null`, `checkedOutAt = null`) and no new version is created.

### Check-in with new version

Send a `multipart/form-data` request containing the updated file:

```bash
curl -X POST "http://localhost:3000/api/files/{fileId}/checkin" \
  -H "Cookie: session=..." \
  -F "file=@bracket_v2.step" \
  -F "description=Updated mounting holes"
```

When a new file is included, the service:

1. Marks the current version as `isLatestVersion = false`.
2. Creates a new file record with `fileVersion` incremented by 1 and `isLatestVersion = true`.
3. Stores the new file content in the vault under a new storage path.
4. Preserves the `branchId` from the original file (so the new version inherits the same branch visibility).
5. The old file record and its stored content are preserved -- nothing is overwritten.

**Batch check-in** is also available:

```
POST /api/files/batch-checkin
{ "fileIds": ["file-uuid-1", "file-uuid-2", ...] }
```

Note: Batch check-in only performs the "unlock only" variant. To upload new versions, files must be checked in individually via multipart upload.

**Enforcement:** Only the user who checked out the file can check it in. Attempting to check in someone else's checkout returns an error.

---

## Discard Checkout

If a user decides not to make changes after checking out a file, they can check it in without uploading a new version. This is functionally the same as "check-in without new version" described above -- the lock is released and no new version is created.

```
POST /api/files/{fileId}/checkin
```

With no file body attached, this simply clears the checkout state. The file returns to its previous state with no version history entry for the discard.

Note that this is distinct from item-level checkout cancellation (see [Lock Hierarchy](#lock-hierarchy)), which operates at the `branchItems` level and may remove the item from the branch entirely if no changes were made.

---

## Lock Status

The lock (checkout) status of any file can be queried:

```
GET /api/files/{fileId}/lock-status
```

**Response when locked:**

```json
{
  "isLocked": true,
  "lockedBy": {
    "id": "user-uuid",
    "name": "Alice Chen",
    "email": "alice@example.com"
  },
  "lockedAt": "2026-03-15T10:30:00.000Z",
  "lockedFor": 45
}
```

The `lockedFor` field is the lock duration in minutes, computed server-side.

**Response when available:**

```json
{
  "isLocked": false
}
```

### Lock Indicators in the UI

The `FileList` component displays lock status inline for every file:

- **Available** -- A green unlock icon with "Available" text.
- **Checked Out** -- An amber lock icon with "Checked Out" text.

Action buttons adapt based on lock state:

- Available files show a **Check Out** button (lock icon).
- Checked-out files show a **Check In** button (unlock icon).
- The **Delete** button is disabled while a file is checked out.

---

## Lock Hierarchy

Cascadia has three complementary locking mechanisms that operate at different levels. For full details, see [`docs/api/lock-hierarchy.md`](../api/lock-hierarchy.md).

### 1. Item Checkout (PLM Workflow)

The primary mechanism for editing items in Cascadia's branching workflow. When an item is checked out to an ECO branch, it creates a `branchItem` record linking the item to the branch. This prevents other users from checking out the same item on the same branch, but does **not** prevent edits on other branches.

- **Scope:** Item on a specific branch
- **API:** `POST /api/items/{id}/checkout`
- **Service:** `CheckoutService`

### 2. Item Lock (Global Exclusive Access)

A stronger lock stored directly on the `items` table. When an item is locked, no user can edit it on any branch. Used sparingly for administrative operations, external system coordination, or data migration.

- **Scope:** Single item across all branches
- **API:** `POST /api/items/{id}/lock`

### 3. File Lock (Vault-Level)

The lock described in this document. Operates on individual files within the vault. Independent of item-level locks -- a file can be locked even if its parent item is not.

- **Scope:** Individual file
- **API:** `POST /api/files/{fileId}/checkout`

### Precedence Rules

```
Item Lock (global)  >  Item Checkout (branch-scoped)  >  File Lock (file-scoped)
```

1. If an item is **locked** (item lock), no checkouts or file edits are allowed.
2. If an item is **checked out** on a branch, other users cannot check out that item on the same branch.
3. If a file is **locked** (file checkout), the file cannot be modified, but item metadata changes may still be allowed.

---

## Primary File Designation

Each item can have one file designated as its **primary model**. This is used for:

- Quick access to the "main" CAD file for a part.
- Thumbnail generation (the primary model's thumbnail is used as the item thumbnail).
- 3D viewer integration (the primary model is loaded by default).

**Auto-assignment:** When the first CAD model file is uploaded to an item, it is automatically marked as the primary model. Subsequent CAD files are not auto-promoted.

**Manual designation:**

```
PUT /api/items/{itemId}/files/primary
{ "fileId": "file-uuid" }
```

This unsets the current primary (if any) and sets the specified file. The file must belong to the item.

**Query the primary model:**

```
GET /api/items/{itemId}/files/primary
```

Returns `{ hasPrimary: true, file: {...} }` or `{ hasPrimary: false, file: null }`.

---

## Multiple Files Per Item

Items can have any number of attached files. This is typical in engineering workflows:

- A Part might have a STEP model, an STL mesh, a drawing PDF, and a specification document.
- A Document might have the source file (Word, Excel) plus exported PDFs.
- A Change Order might have impact analysis spreadsheets and meeting notes.

The file listing endpoint returns all files for an item:

```
GET /api/items/{itemId}/files
GET /api/items/{itemId}/files?branchId=...&mainBranchId=...
```

The optional `branchId` and `mainBranchId` query parameters enable branch-aware filtering (see [Branch-Aware Storage](#branch-aware-storage)).

There is also a specialized endpoint for retrieving only viewable CAD files (STL, OBJ, GLB, glTF), including files from related CAD Document items:

```
GET /api/items/{itemId}/cad-files
```

This endpoint traverses "CAD Doc" relationships to find viewable models attached to related Document items, returning both direct and related files.

---

## File Metadata

### Core Fields

Every file record in the vault contains:

| Field              | Type              | Description                                                 |
| ------------------ | ----------------- | ----------------------------------------------------------- |
| `id`               | UUID              | Unique file identifier                                      |
| `itemId`           | UUID              | The item this file belongs to                               |
| `branchId`         | UUID or null      | Branch the file was uploaded on (null = visible everywhere) |
| `fileName`         | string            | Sanitized filename used in storage                          |
| `originalFileName` | string            | User's original filename (preserved for display/download)   |
| `fileSize`         | bigint            | Size in bytes                                               |
| `mimeType`         | string            | MIME type (max 200 chars)                                   |
| `fileHash`         | string            | SHA-256 content hash (64 hex chars)                         |
| `storageType`      | string            | Storage backend: `local`, `s3`                              |
| `storagePath`      | string            | Relative path from vault root                               |
| `fileVersion`      | integer           | Version number (starts at 1, increments on check-in)        |
| `isLatestVersion`  | boolean           | True for the current version only                           |
| `isCheckedOut`     | boolean           | Lock status                                                 |
| `checkedOutBy`     | UUID or null      | User holding the lock                                       |
| `checkedOutAt`     | timestamp         | When the lock was acquired                                  |
| `uploadedBy`       | UUID              | User who uploaded the file                                  |
| `uploadedAt`       | timestamp         | Upload timestamp                                            |
| `metadata`         | JSONB             | Extracted and user-provided metadata                        |
| `fileCategory`     | string            | Auto-detected category                                      |
| `isPrimaryModel`   | boolean           | Primary CAD model designation                               |
| `cadMetadata`      | JSONB             | CAD-specific properties                                     |
| `thumbnailFileId`  | UUID or null      | Reference to a thumbnail image file                         |
| `deletedAt`        | timestamp or null | Soft-delete timestamp                                       |
| `deletedBy`        | UUID or null      | User who deleted the file                                   |

### File Categories

Files are automatically categorized based on their extension and filename:

| Category        | Extensions / Patterns                                                                                                                     | Description                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `cad_model`     | `.step`, `.stp`, `.stl`, `.obj`, `.sldprt`, `.prt`, `.ipt`, `.catpart`, `.3dm`, `.ply`, `.glb`, `.gltf`, `.sldasm`, `.iam`, `.catproduct` | 3D CAD models and assemblies    |
| `drawing`       | `.dwg`, `.dxf`, `.pdf` (with "drawing" in filename)                                                                                       | 2D engineering drawings         |
| `specification` | `.pdf`, Word docs with "spec", "requirement", or "datasheet" in filename                                                                  | Technical specifications        |
| `analysis`      | Files with "analysis", "fea", or "simulation" in filename                                                                                 | Analysis and simulation results |
| `reference`     | Everything else                                                                                                                           | General reference documents     |

Thumbnails (generated by the CAD converter service) have a special `thumbnail` category and are automatically excluded from normal file listings.

### CAD Metadata

CAD model files carry additional structured metadata in the `cadMetadata` JSONB column:

```typescript
{
  software?: string       // e.g., "SolidWorks 2024", "Fusion360"
  units?: string          // e.g., "mm", "in", "ft"
  polygonCount?: number   // For mesh files (STL, OBJ)
  boundingBox?: {         // Model dimensions
    x: number
    y: number
    z: number
  }
}
```

### Audit History

Every significant file action is logged to the `vault_file_history` table:

| Action        | When Logged                                   |
| ------------- | --------------------------------------------- |
| `upload`      | File first uploaded                           |
| `download`    | File downloaded (including version downloads) |
| `checkout`    | File checked out                              |
| `checkin`     | File checked in (with or without new version) |
| `delete`      | File soft-deleted                             |
| `restore`     | Soft-deleted file restored                    |
| `set_primary` | File designated as primary model              |

Each history record includes the performing user, timestamp, and a JSONB `details` field with action-specific data (file size, version number, original filename, etc.).

The history for a specific file is available via:

```
GET /api/files/{fileId}/versions
```

This returns all versions ordered by version number descending, with uploader information.

---

## Branch-Aware Storage

One of the vault's most important features is branch-aware file visibility. This integrates directly with Cascadia's "ECO-as-Branch" model.

### How It Works

Every vault file has an optional `branchId` field. This field determines where the file is visible:

| `branchId` value | Visibility                                        |
| ---------------- | ------------------------------------------------- |
| `null`           | Visible everywhere (legacy files, promoted files) |
| Main branch ID   | Visible on main and all branches                  |
| ECO branch ID    | Visible only on that specific ECO branch          |

When listing files for an item, the API accepts `branchId` and `mainBranchId` query parameters to filter accordingly:

```
GET /api/items/{itemId}/files?branchId=eco-123&mainBranchId=main-456
```

The service applies this logic:

1. Always include files where `branchId IS NULL` (global files).
2. Include files where `branchId = mainBranchId` (main branch files).
3. Include files where `branchId = branchId` (current ECO branch files).

### Practical Example

Suppose Part-001 has a `bracket.step` file on main. An engineer creates ECO-042 and uploads a revised `bracket_v2.step` on the ECO branch.

- Users viewing Part-001 on **main** see only `bracket.step`.
- Users viewing Part-001 on **ECO-042** see both `bracket.step` (from main) and `bracket_v2.step` (from the ECO branch).
- When ECO-042 is approved and released, `bracket_v2.step` is promoted to global visibility (see next section).

### Upload Branch Context

The upload endpoint accepts a `branchId` field in the form data. When provided, the file record is created with that branch ID, limiting its visibility to that branch (plus main). The `FileUploadZone` UI component automatically includes the current branch context if available.

---

## File Promotion on Merge

When an ECO is released and its branch is merged to main, all files uploaded on that branch must become globally visible. This is handled by the `promoteFilesToMain` method.

### What Happens

During ECO release (in `ChangeOrderMergeService`), after all item merges and revision assignments:

```typescript
const filesPromoted = await FileService.promoteFilesToMain(branchId)
```

This sets `branchId = null` on every vault file that was uploaded on the ECO branch. Once `branchId` is null, the files are visible regardless of branch context.

This is step 7 in the ECO merge sequence, ensuring that file visibility is always consistent with item visibility after release.

---

## Storage Abstraction

The vault's storage layer is abstracted behind the `VaultStorage` interface:

```typescript
interface VaultStorage {
  store(path: string, data: Buffer | ReadableStream): Promise<void>
  retrieve(path: string): Promise<Buffer>
  createReadStream(path: string): Promise<ReadableStream>
  delete(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  getSize(path: string): Promise<number>
}
```

Two implementations are provided. A third (Azure Blob Storage) is planned.

### Local Filesystem

**Class:** `LocalFileStorage`

Stores files in a directory on the server's filesystem. This is the default for development and single-server deployments.

**Security features:**

- Directory traversal prevention (paths are validated against the vault root).
- Restrictive file permissions (`0o600` -- owner read/write only).
- Vault root directory created with `0o700` permissions.
- Empty parent directories are cleaned up after file deletion.

**Configuration:**

| Source      | Setting                                    | Default   |
| ----------- | ------------------------------------------ | --------- |
| Database    | `vault_root` setting via `SettingsService` | --        |
| Environment | `VAULT_ROOT`                               | `./vault` |

Priority: Database setting > Environment variable > Default `./vault`.

### S3-Compatible Storage

**Class:** `S3Storage`

Stores files in any S3-compatible object store. Uses the AWS SDK v3 (`@aws-sdk/client-s3`).

**Supported backends:**

- AWS S3
- MinIO
- DigitalOcean Spaces
- LocalStack (for testing)
- Any S3-compatible service

**Configuration via environment variables:**

| Variable               | Required          | Description                                |
| ---------------------- | ----------------- | ------------------------------------------ |
| `VAULT_TYPE`           | Yes (set to `s3`) | Selects S3 backend                         |
| `S3_BUCKET`            | Yes               | Bucket name                                |
| `S3_REGION`            | No                | AWS region (default: `us-east-1`)          |
| `S3_KEY_PREFIX`        | No                | Optional prefix for all object keys        |
| `S3_ENDPOINT`          | No                | Custom endpoint for S3-compatible services |
| `S3_ACCESS_KEY_ID`     | No                | Explicit credentials (omit for IAM roles)  |
| `S3_SECRET_ACCESS_KEY` | No                | Explicit credentials (omit for IAM roles)  |
| `S3_FORCE_PATH_STYLE`  | No                | Set `true` for MinIO/LocalStack            |

When `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` are omitted, the SDK falls back to IAM role credentials, which is the recommended approach for AWS deployments.

### Configuration Priority

The `StorageFactory` resolves storage configuration in this order:

1. **`VAULT_TYPE` environment variable** determines the backend (`local` or `s3`).
2. For local storage: database `vault_root` setting > `VAULT_ROOT` env var > `./vault` default.
3. For S3 storage: all configuration comes from environment variables.

The factory caches the storage instance and reuses it across requests. Call `StorageFactory.clearCache()` if settings change at runtime.

---

## API Reference

### File Operations

| Method | Endpoint                                          | Permission         | Description                                      |
| ------ | ------------------------------------------------- | ------------------ | ------------------------------------------------ |
| POST   | `/api/items/{itemId}/files/upload`                | Authenticated      | Upload files to an item                          |
| GET    | `/api/items/{itemId}/files`                       | Authenticated      | List files for an item (branch-aware)            |
| GET    | `/api/items/{itemId}/files/primary`               | `documents:read`   | Get primary CAD model                            |
| PUT    | `/api/items/{itemId}/files/primary`               | Authenticated      | Set primary CAD model                            |
| GET    | `/api/items/{itemId}/cad-files`                   | Authenticated      | List viewable CAD files (including related docs) |
| GET    | `/api/files/{fileId}/download`                    | `documents:read`   | Download a file                                  |
| GET    | `/api/files/{fileId}/metadata`                    | `documents:read`   | Get file metadata                                |
| GET    | `/api/files/{fileId}/versions`                    | `documents:read`   | List all versions                                |
| GET    | `/api/files/{fileId}/versions/{version}/download` | `documents:read`   | Download specific version                        |
| GET    | `/api/files/{fileId}/thumbnail`                   | `documents:read`   | Get file thumbnail                               |
| DELETE | `/api/files/{fileId}`                             | `documents:delete` | Soft-delete a file                               |

### Lock Operations

| Method | Endpoint                          | Permission         | Description                                      |
| ------ | --------------------------------- | ------------------ | ------------------------------------------------ |
| POST   | `/api/files/{fileId}/checkout`    | `documents:update` | Check out (lock) a file                          |
| POST   | `/api/files/{fileId}/checkin`     | `documents:update` | Check in (unlock, optionally upload new version) |
| GET    | `/api/files/{fileId}/lock-status` | `documents:read`   | Get lock status                                  |
| POST   | `/api/files/batch-checkout`       | `documents:update` | Batch check out (max 100)                        |
| POST   | `/api/files/batch-checkin`        | `documents:update` | Batch check in (max 100)                         |

### CAD Operations

| Method | Endpoint                      | Permission       | Description                                    |
| ------ | ----------------------------- | ---------------- | ---------------------------------------------- |
| POST   | `/api/files/{fileId}/convert` | `documents:read` | Submit a CAD conversion job (STEP/IGES to STL) |

---

## Key Files

| File                                       | Purpose                                                                |
| ------------------------------------------ | ---------------------------------------------------------------------- |
| `src/lib/vault/services/FileService.ts`    | Core service: upload, download, checkout, checkin, versioning, listing |
| `src/lib/vault/storage/types.ts`           | `VaultStorage` interface and configuration types                       |
| `src/lib/vault/storage/local-storage.ts`   | Local filesystem storage implementation                                |
| `src/lib/vault/storage/s3-storage.ts`      | S3-compatible storage implementation                                   |
| `src/lib/vault/storage/storage-factory.ts` | Factory for creating storage instances from config                     |
| `src/lib/vault/utils/file-utils.ts`        | File validation, hashing, categorization, path generation              |
| `src/lib/db/schema/vault.ts`               | Database schema: `vault_files` and `vault_file_history` tables         |
| `src/components/vault/FileList.tsx`        | UI component: file listing with lock status and actions                |
| `src/components/vault/FileUploadZone.tsx`  | UI component: drag-and-drop file upload                                |
| `src/routes/api/files/`                    | API route handlers for all file operations                             |
| `src/routes/api/items/$itemId/files/`      | API route handlers for item-scoped file operations                     |
| `docs/api/lock-hierarchy.md`               | Detailed documentation of all three lock types                         |
