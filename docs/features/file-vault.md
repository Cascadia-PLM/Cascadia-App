# File Vault and Document Control

The file vault is Cascadia's enterprise file management system. It provides PDM-style (Product Data Management) check-in/check-out, automatic versioning, branch-aware storage, and pluggable storage backends. Every file attached to an item -- CAD models, drawings, specifications, analysis reports -- flows through the vault.

---

## Table of Contents

- [Overview](#overview)
- [File Upload and Download](#file-upload-and-download)
  - [Uploading Files](#uploading-files)
  - [Downloading Files](#downloading-files)
  - [Previewing Files In-App](#previewing-files-in-app)
  - [Marking Up a File](#marking-up-a-file)
  - [Watermarking](#watermarking)
  - [Batch Uploads](#batch-uploads)
- [Check-Out for Edit](#check-out-for-edit)
- [Check-In with Versioning](#check-in-with-versioning)
- [Discard Checkout](#discard-checkout)
- [Lock Status](#lock-status)
- [Lock Hierarchy](#lock-hierarchy)
- [Primary File Designation](#primary-file-designation)
- [Multiple Files Per Item](#multiple-files-per-item)
- [File Metadata](#file-metadata)
  - [Extracted Metadata](#extracted-metadata)
  - [File Categories](#file-categories)
  - [Correcting a Category](#correcting-a-category)
  - [Image Gallery](#image-gallery)
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

The vault is implemented primarily in `packages/core/src/lib/vault/`, with the `FileService` class providing the service layer and the `VaultStorage` interface abstracting the storage backend.

---

## File Upload and Download

### Uploading Files

Files are attached to items (Parts, Documents, Change Orders, etc.) via multipart form upload. The upload route is:

```
POST /api/v1/items/{itemId}/files/upload
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
curl -X POST "http://localhost:3000/api/v1/items/{itemId}/files/upload" \
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
GET /api/v1/files/{fileId}/download
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

### Previewing Files In-App

Attached documents can be read without leaving Cascadia. A separate endpoint
serves the same bytes for _rendering_ rather than for _saving_:

```
GET /api/v1/files/{fileId}/content
```

It differs from `/download` in three ways, each deliberate:

|                       | `/download`           | `/content`                           |
| --------------------- | --------------------- | ------------------------------------ |
| `Content-Disposition` | `attachment`          | `inline`                             |
| `Content-Type`        | the stored `mimeType` | resolved from the file **extension** |
| History action logged | `download`            | `view`                               |

**The Content-Type is never echoed back from the upload.** The stored
`mimeType` is whatever the uploading client asserted, so a file claiming to be
`application/pdf` would otherwise be served inline under that type. The
extension has already passed the vault's upload allowlist, so it is the
trustworthy signal; a `.txt` uploaded as `application/pdf` is served as
`text/plain`. Responses also carry `X-Content-Type-Options: nosniff` and
`Content-Security-Policy: sandbox; default-src 'none'`.

Only formats Cascadia can display are served, up to a **50 MB ceiling**
(neither the storage layer nor the API speaks HTTP Range yet, so the viewer
fetches a file whole; past that point downloading is the cheaper path). Anything
else returns `415 FILE_TYPE_NOT_ALLOWED`; anything larger returns
`413 FILE_TOO_LARGE`. A format may declare a lower ceiling of its own when its
_viewer_, rather than the transfer, is what gives out first.

| Kind    | Extensions                                  | Ceiling | Rendered by                                    |
| ------- | ------------------------------------------- | ------- | ---------------------------------------------- |
| `pdf`   | `.pdf`                                      | 50 MB   | pdf.js, on canvas with a selectable text layer |
| `image` | `.png` `.jpg` `.jpeg` `.gif` `.bmp` `.webp` | 50 MB   | `<img>`                                        |
| `svg`   | `.svg`                                      | 8 MB    | `<img>`, in a zoom/pan/rotate viewer           |
| `text`  | `.txt` `.md` `.csv` `.log`                  | 50 MB   | preformatted text                              |

TIFF is excluded — no browser renders it.

#### Why SVG is a kind of its own

SVG is the one previewable format that is also a scripting host, and it is
handled unlike the rest because of it. Three things keep it safe, and **all
three have to hold**:

1. **The server never labels it `image/svg+xml`.** It goes out as `text/plain`
   like any other text flavour, so a browser that reaches the endpoint directly
   renders source, not markup.
2. **The viewer renders it through an `<img>`**, which the SVG spec puts in
   [secure static mode](https://www.w3.org/TR/SVG2/conform.html#secure-static-mode):
   no script, no external references, no interactivity.
3. **The viewer's `src` is a `data:` URL, not an object URL.** This is the
   subtle one. `URL.createObjectURL` mints a `blob:` URL that inherits the
   app's origin, so a viewer who picks "open image in new tab" would load the
   drawing as a top-level document _on Cascadia's origin_ — and a document,
   unlike an `<img>`, runs the script the SVG carries. Browsers refuse
   top-level navigation to a `data:` URL, and a `data:` document gets an opaque
   origin regardless.

Folding SVG into the `image` kind would quietly break (2) and (3) at once,
which is why it is a separate `PreviewKind` with its own viewer rather than a
sixth image extension. `preview.test.ts` pins the Content-Type and the kind as
invariants so neither can be relaxed without the test going red.

The 8 MB ceiling is the data URL's doing: percent-encoding roughly doubles the
source and it has to be built as a single JavaScript string. Drawings past that
are traced bitmaps that would render badly anyway, so they are offered as a
download.

This is orthogonal to thumbnails and the gallery, which still refuse SVG
outright: both point an `<img>` straight at `/content`, and (1) means those
bytes arrive as text.

The vocabulary lives in `packages/core/src/lib/vault/preview.ts` and is shared by the server
(the allowlist) and the client (whether to offer a Preview action, and which
viewer to mount). Adding a format means adding one entry there.

**In the UI.** The `FileList` row actions carry a Preview button for every
previewable file, so every item type that renders a file list — Part, Document,
Change Order, Physical Part, and any type added later — gets the viewer without
further work. Documents additionally have a full-width **Preview tab**
(`/documents/{id}?tab=preview`) backed by `ItemFilePreviewPanel`, which is
itself item-type agnostic and can be dropped into any detail page. Like the
[Gallery tab](#image-gallery), it only appears when there is something to show —
`useItemPreviewableFiles` answers that from the file list's own query.

The image extensions come from `image-files.ts`, the same list the gallery and
the thumbnail designation use, so the three cannot drift. Only the mapping from
extension to `Content-Type` lives in `preview.ts`, because only the content
endpoint serves bytes. Note that `isDisplayableImage` falls back to the stored
`mimeType` for oddly-named uploads and the preview allowlist deliberately does
not: deciding whether to _show_ a file an `<img>` already fetched is a different
risk from deciding what `Content-Type` to _serve_ it under.

The viewer fetches with `fetch` and hands the bytes over as an object URL
rather than pointing an `<iframe>` at the endpoint: every API response carries
`X-Frame-Options: DENY`, and the endpoint is session-cookie authenticated.

pdf.js is code-split behind a dynamic import, so the roughly 1.4 MB of viewer
and worker is only fetched the first time someone opens a PDF. Its character
maps and Base-14 font data are copied into the build by `vite-plugin-static-copy`
and served from `/pdfjs/` — not a CDN — so previewing works in air-gapped
deployments.

### Marking Up a File

Redlines are drawn directly in the viewer: highlight, box, freehand, comment
pin, and text label, in five colours.

**Markup is stored as PLM data, not written into the PDF.** A vault file version
is immutable and carries the SHA-256 recorded at upload, so writing a stroke
back into the bytes would mint a new version on every pen-down and invalidate
that hash. Keeping markup beside the file also makes it queryable and
attributable, and it can still be flattened into a PDF on demand.

Geometry is stored in **normalized page coordinates** (`0..1` from the top-left
of the unrotated page). A stroke drawn at 400% zoom on a rotated page has to
land in the same place when reopened at 100% on a different screen, and when
stamped into the PDF by a worker that never saw the viewport.

**Writing markup requires holding the owning item's checkout.** Marking up a
released drawing is an edit to the engineering record, not a personal sticky
note, so it belongs to whoever currently owns that record — which also means
redlines accumulate against a branch someone is accountable for instead of
appearing on main with nobody's name on the change. Reading is not gated: a
reviewer with design access sees the redlines without taking the lock away from
whoever is drawing them.

The gate is the checkout itself, deliberately _not_
`ItemService.requireContentEditable`. That is the contract for **structural**
edits, and it additionally insists a revision working copy exist before a
released item can be touched; markup writes no item row and no relationship, so
requiring it would mean revising a document before you could redline it. The
lookup matches on `itemMasterId`, so markup keeps working across the moment a
working copy is created and the branch row's `currentItemId` moves.

| Situation                     | Result                       |
| ----------------------------- | ---------------------------- |
| Nobody holds the checkout     | `409 ITEM_CHECKOUT_REQUIRED` |
| Somebody else holds it        | `423 RESOURCE_LOCKED`        |
| Branch locked (ECO submitted) | `403 BRANCH_PROTECTION`      |
| You hold it                   | Markup is written            |

Only the **author** may revise their own markup — an annotation is an attributed
statement about the document, and letting someone else rewrite it under that
name would make the attribution a lie. Anyone holding the checkout may _delete_
markup that no longer applies.

Markup hangs off a `vault_files` row — one version of one file — so branch
visibility and file versioning come for free: redlines drawn on an ECO branch
are visible exactly where that file version is, and are promoted with it on
release.

```
GET    /api/v1/files/{fileId}/annotations
POST   /api/v1/files/{fileId}/annotations
PATCH  /api/v1/files/{fileId}/annotations/{annotationId}
DELETE /api/v1/files/{fileId}/annotations/{annotationId}
```

Vocabulary lives in `packages/core/src/lib/vault/annotations.ts`, shared by the viewer, the
API, and anything that renders markup into a PDF.

### Watermarking

Stamping a mark — `SUPERSEDED`, `UNCONTROLLED COPY`, `FOR REVIEW ONLY` — runs as
the background job `document.watermark.apply`.

A stamp is drawn as **page content, not a PDF annotation**, so it cannot be
toggled off in a reader or removed by "strip annotations". Someone holding a
superseded drawing has to see that it is superseded. Three positions are
available: `diagonal` (corner to corner, sized to ~80% of the page diagonal so
an A0 sheet and a Letter spec are both legibly marked) and `top-banner` /
`bottom-banner` (a solid bar, better on a dense sheet where the diagonal would
cross the drawing).

**Automatic on ECO release.** When an ECO merges, every revision it superseded
gets its PDFs stamped `SUPERSEDED`, subtitled with the revision that replaced
it. Files belong to an item _version_ row, so the superseded revision still owns
its own attachments — the ones stamped are exactly those, and the new revision's
files are untouched. One job is queued per superseded revision, so a document
whose attachments fail to stamp can be retried without re-stamping the rest.

Dispatched rather than done inline: a release can supersede dozens of documents,
and a stamping failure must be retried on its own rather than rolling back a
release that has already happened. If the dispatch itself fails, the release
still succeeds and the failure is logged.

Manual dispatch, same job, same trace in the file history:

```
POST /api/v1/files/{fileId}/watermark
{ "text": "UNCONTROLLED COPY", "position": "bottom-banner" }   → 202 { jobId }
```

Stamping writes a **new file version** through `FileService.replaceContent`, so
the pre-stamp original stays downloadable in the version history. That method is
the system-driven counterpart to check-in and is deliberately not an escape
hatch around the lock: it refuses a file someone has checked out (their
check-in would silently discard the stamp) and refuses anything but the latest
version (superseded versions are frozen history). The job also skips files that
already carry the same mark, so re-running a release cannot stack two identical
stamps.

Per-file failures are collected rather than thrown: one vendor PDF that pdf-lib
cannot parse must not stop the other forty being marked.

Stamping uses [`@cantoo/pdf-lib`](https://www.npmjs.com/package/@cantoo/pdf-lib)
— the maintained MIT fork of `pdf-lib`, which has had no release since 2022. MIT
matters: Cascadia is dual licensed, and its proprietary edition cannot take an
AGPL dependency such as MuPDF without a commercial licence from Artifex.

### Batch Uploads

The upload endpoint accepts multiple files in a single request. Each file in the form data is processed sequentially, and all resulting file records are returned together.

---

## Check-Out for Edit

Checking out a file is the vault's mechanism for exclusive editing. When a user checks out a file, it is locked -- no other user can check out or modify that file until the original user checks it back in.

**Why is this needed?** In engineering workflows, two people editing the same CAD model simultaneously leads to lost work. Unlike text files that can be merged, binary CAD files cannot. Check-out prevents this by ensuring only one person edits at a time.

```
POST /api/v1/files/{fileId}/checkout
```

**What happens on checkout:**

1. The system verifies the file exists and is not deleted.
2. If the file is already checked out (by any user), the request fails with an error identifying the current holder.
3. The file record is updated with `isCheckedOut = true`, the user's ID, and a timestamp.
4. The action is logged to the file history.

**Batch checkout** is available for workflows where multiple files need to be locked simultaneously (common in CAD assembly editing):

```
POST /api/v1/files/batch-checkout
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
POST /api/v1/files/{fileId}/checkin
```

There are two modes:

### Check-in without new version (unlock only)

Send the request with no body or a JSON body. The file is unlocked (`isCheckedOut = false`, `checkedOutBy = null`, `checkedOutAt = null`) and no new version is created.

### Check-in with new version

Send a `multipart/form-data` request containing the updated file:

```bash
curl -X POST "http://localhost:3000/api/v1/files/{fileId}/checkin" \
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
POST /api/v1/files/batch-checkin
{ "fileIds": ["file-uuid-1", "file-uuid-2", ...] }
```

Note: Batch check-in only performs the "unlock only" variant. To upload new versions, files must be checked in individually via multipart upload.

**Enforcement:** Only the user who checked out the file can check it in. Attempting to check in someone else's checkout returns an error.

---

## Discard Checkout

If a user decides not to make changes after checking out a file, they can check it in without uploading a new version. This is functionally the same as "check-in without new version" described above -- the lock is released and no new version is created.

```
POST /api/v1/files/{fileId}/checkin
```

With no file body attached, this simply clears the checkout state. The file returns to its previous state with no version history entry for the discard.

Note that this is distinct from item-level checkout cancellation (see [Lock Hierarchy](#lock-hierarchy)), which operates at the `branchItems` level and may remove the item from the branch entirely if no changes were made.

---

## Lock Status

The lock (checkout) status of any file can be queried:

```
GET /api/v1/files/{fileId}/lock-status
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

Cascadia has three complementary locking mechanisms that operate at different levels.

### 1. Item Checkout (PLM Workflow)

The primary mechanism for editing items in Cascadia's branching workflow. When an item is checked out to an ECO branch, it creates a `branchItem` record linking the item to the branch. This prevents other users from checking out the same item on the same branch, but does **not** prevent edits on other branches.

- **Scope:** Item on a specific branch
- **API:** `POST /api/v1/items/{id}/checkout`
- **Service:** `CheckoutService`

### 2. Item Lock (Global Exclusive Access)

A stronger lock stored directly on the `items` table. When an item is locked, no user can edit it on any branch. Used sparingly for administrative operations, external system coordination, or data migration.

- **Scope:** Single item across all branches
- **API:** `POST /api/v1/items/{id}/lock`

### 3. File Lock (Vault-Level)

The lock described in this document. Operates on individual files within the vault. Independent of item-level locks -- a file can be locked even if its parent item is not.

- **Scope:** Individual file
- **API:** `POST /api/v1/files/{fileId}/checkout`

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
- Thumbnail generation (the primary model's thumbnail is used as the item thumbnail, unless the user has designated an image — see [Item Thumbnails](#item-thumbnails)).
- 3D viewer integration (the primary model is loaded by default).

**Auto-assignment:** When the first CAD model file is uploaded to an item, it is automatically marked as the primary model. Subsequent CAD files are not auto-promoted.

**Manual designation:**

```
PUT /api/v1/items/{itemId}/files/primary
{ "fileId": "file-uuid" }
```

This unsets the current primary (if any) and sets the specified file. The file must belong to the item.

**Query the primary model:**

```
GET /api/v1/items/{itemId}/files/primary
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
GET /api/v1/items/{itemId}/files
GET /api/v1/items/{itemId}/files?branchId=...&mainBranchId=...
```

The optional `branchId` and `mainBranchId` query parameters enable branch-aware filtering (see [Branch-Aware Storage](#branch-aware-storage)).

There is also a specialized endpoint for retrieving only viewable CAD files (STL, OBJ, GLB, glTF), including files from related CAD Document items:

```
GET /api/v1/items/{itemId}/cad-files
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
| `fileCategory`     | string            | File category (detected at upload, correctable)             |
| `categorySource`   | string            | `auto` while detected, `manual` once a person has set it    |
| `isPrimaryModel`   | boolean           | Primary CAD model designation                               |
| `isItemThumbnail`  | boolean           | User-designated item thumbnail (at most one per item)       |
| `cadMetadata`      | JSONB             | CAD-specific properties                                     |
| `thumbnailFileId`  | UUID or null      | Reference to a thumbnail image file                         |
| `deletedAt`        | timestamp or null | Soft-delete timestamp                                       |
| `deletedBy`        | UUID or null      | User who deleted the file                                   |

### Extracted Metadata

Every upload and check-in writes a small set of derived keys into the `metadata`
JSONB column, alongside whatever the caller supplied (the caller's values win on
a collision):

| Key                | When                       | Value                                        |
| ------------------ | -------------------------- | -------------------------------------------- |
| `extension`        | always                     | Lowercased file extension, e.g. `.pdf`       |
| `category`         | always                     | Broad MIME class, e.g. `pdf`, `image`, `cad` |
| `detectedCategory` | always                     | The detected file category (see below)       |
| `cadFormat`        | CAD extensions             | Format name, e.g. `STEP`, `SolidWorks`       |
| `isViewable`       | CAD extensions             | Whether the in-app 3D viewer can render it   |
| `pageCount`        | `.pdf` under 32 MB         | Number of pages                              |
| `title` / `author` | `.pdf` under 32 MB, if set | PDF document properties                      |
| `pdfProducer`      | `.pdf` under 32 MB, if set | Producing application                        |

PDF extraction is gated on the **file extension**, never the caller-supplied
`mimeType`, and is bounded: files over 32 MB are not opened, and any parse
failure is swallowed so a malformed or vendor-mangled PDF still uploads with the
rest of its metadata intact. Extraction is not retroactive — files uploaded
before this existed keep the keys they were given.

Image EXIF and native CAD property parsing are deliberately out of scope. EXIF
would mean a native binary dependency (`sharp`, `exif-parser`) in the published
AGPL core package for fields nothing reads; CAD properties for converted models
already arrive in the typed `cadMetadata` column from the converter worker (see
[CAD Metadata](#cad-metadata)), and the vendor formats that are never converted
would need a vendor SDK.

### File Categories

Files are automatically categorized based on their extension and filename:

| Category        | Extensions / Patterns                                                                                                                     | Description                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `cad_model`     | `.step`, `.stp`, `.stl`, `.obj`, `.sldprt`, `.prt`, `.ipt`, `.catpart`, `.3dm`, `.ply`, `.glb`, `.gltf`, `.sldasm`, `.iam`, `.catproduct` | 3D CAD models and assemblies    |
| `drawing`       | `.dwg`, `.dxf`, `.slddrw`, `.idw`, `.drw`, `.dft`, `.catdrawing`, or "drawing"/"dwg" in the filename                                      | 2D engineering drawings         |
| `analysis`      | "analysis", "fea", or "simulation" in the filename                                                                                        | Analysis and simulation results |
| `specification` | PDF, Word, or text files with "spec", "requirement", or "datasheet" in the filename                                                       | Technical specifications        |
| `reference`     | Everything else                                                                                                                           | General reference documents     |

An extension decides the category only when the format itself is unambiguous —
a `.sldprt` is always a model, a `.slddrw` is always a drawing. **A `.pdf` is
not**: it can hold a drawing, a spec, a certificate, a test report, or anything
else, so PDFs (and `.doc`/`.docx`/`.rtf`/`.odt`/`.txt`) are categorized by
filename hints and otherwise stay `reference` rather than being asserted as
drawings.

Filename hints match whole words, bounded by the start of the name or a
separator (space, dash, underscore, dot). `Inspection_Report.pdf` is therefore
not read as a "spec", and `Feature_List.pdf` is not read as an "fea" run.

Thumbnails (generated by the CAD converter service) have a special `thumbnail` category and are automatically excluded from normal file listings.

The vocabulary lives in `packages/core/src/lib/vault/file-categories.ts` — labels, badge
styling, filter options, and the picker all read from it, so adding a category
means adding one entry there.

### Correcting a Category

Detection is a guess from the filename, so every category is correctable. The
category picker sits in the file row actions on the item detail page and in the
row and context menus on `/files`.

```
PATCH /api/v1/files/{fileId}/category
{ "category": "specification" }   // record a person's answer
{ "category": null }              // clear the override, detect again
```

A category set this way is stored with `categorySource: 'manual'` and is
authoritative from then on: nothing re-detects over it, including a new version
uploaded on check-in. Sending `null` clears the override and re-runs detection
against the current filename. Either way the change is written to the file's
audit history as a `set_category` entry recording the old and new values.

Two things follow a category change:

- **Primary model.** `isPrimaryModel` only ever rides a `cad_model`.
  Recategorizing the primary model as something else clears the flag (without
  promoting another file — the item simply has no primary until someone picks
  one); categorizing a file as `cad_model` adopts the flag if the item has no
  primary yet, and leaves an existing primary alone.
- **Generated thumbnails** are system-managed and rejected — their category is
  what keeps them out of file listings.

Files uploaded before a detection rule changed keep the category they were
given at upload; the rules apply at upload time, not retroactively.

### Item Thumbnails

`GET /api/v1/items/{itemId}/thumbnail` serves the image shown for an item in the
parts table and on the part detail header. It resolves in this order:

1. **A user-designated image** — any uploaded PNG/JPEG/GIF/BMP/WebP flagged with
   `isItemThumbnail`. The image is served directly; it stays a normal attachment
   and keeps its own category.
2. The **primary CAD model's** generated thumbnail (`thumbnailFileId`).
3. Any other file's generated thumbnail.

A user designates an image either at upload time (the upload zone shows a
"use as thumbnail" toggle on image files, which posts `file_N_isThumbnail=true`)
or afterwards from the file list. Designation is exclusive per item — setting a
new one clears the previous. Clearing it falls back to the generated CAD
thumbnail, so hand-picking a photo never destroys the rendered one.

SVG and TIFF are rejected: thumbnails are served inline, and SVG is scriptable.
The designation moves to the new version on check-in, and is skipped if the
replacement is no longer a usable image.

| Method | Path                                     | Permission         | Description                           |
| ------ | ---------------------------------------- | ------------------ | ------------------------------------- |
| GET    | `/api/v1/items/{itemId}/files/thumbnail` | `documents:read`   | Which file is designated, if any      |
| PUT    | `/api/v1/items/{itemId}/files/thumbnail` | `documents:update` | Designate a file (body: `{ fileId }`) |
| DELETE | `/api/v1/items/{itemId}/files/thumbnail` | `documents:update` | Clear the designation                 |

### Image Gallery

Parts and documents with image attachments grow a **Gallery** tab
(`?tab=gallery`) beside Details. It shows every attached image the browser can
render — the same PNG/JPEG/GIF/BMP/WebP rule the thumbnail designation uses,
shared from `packages/core/src/lib/vault/image-files.ts` — as a grid of tiles, and opens any
of them full size in a lightbox with previous/next navigation (arrow keys
included) and a download button.

The tab is hidden when an item has no images, and the gallery resolves files in
the current version context, so an image uploaded on an ECO branch appears only
while that branch is selected. It reads the same `GET /api/v1/items/{itemId}/files`
query as the file list — no separate endpoint, and no extra request.

The gallery and the [Preview tab](#previewing-files-in-app) answer different
questions and both can be present. Gallery is a contact sheet: every image at
once, click to enlarge. Preview is a document reader: one file, paged, zoomed,
and markable. A document with a spec PDF and three photos shows both; one with
only photos shows only Gallery.

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

| Action        | When Logged                                    |
| ------------- | ---------------------------------------------- |
| `upload`      | File first uploaded                            |
| `download`    | File downloaded (including version downloads)  |
| `view`        | File rendered in the in-app viewer             |
| `watermark`   | A mark was stamped onto a PDF (new version)    |
| `sign`        | A digital signature was embedded (new version) |
| `checkout`    | File checked out                               |
| `checkin`     | File checked in (with or without new version)  |
| `delete`      | File soft-deleted                              |
| `restore`     | Soft-deleted file restored                     |
| `set_primary` | File designated as primary model               |

Each history record includes the performing user, timestamp, and a JSONB `details` field with action-specific data (file size, version number, original filename, etc.).

The history for a specific file is available via:

```
GET /api/v1/files/{fileId}/versions
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
GET /api/v1/items/{itemId}/files?branchId=eco-123&mainBranchId=main-456
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

### Branch visibility is only half of it

`branchId` answers _where_ a file is visible. `itemId` answers _which version owns
it_ — and it is a foreign key to a row in `items`, meaning one **version** of an
item, not the item's `masterId`. Every file listing resolves the item to a single
version row and looks files up by that row's id.

That matters because most of the versioning machinery works by minting a **new**
`items` row:

| Step                                                              | New row for                        |
| ----------------------------------------------------------------- | ---------------------------------- |
| `ChangeOrderService.createRevisionWorkingCopy()`                  | the working copy on the ECO branch |
| `CheckoutService.saveChanges()` (first save)                      | the working copy on the branch     |
| `ConflictDetectionService.rebaseItem()` / `pullChangesFromMain()` | the rebased working copy           |
| `ChangeOrderMergeService` merging an `added` item                 | the released revision              |
| `ItemService.revise()` (affected-item `revise` action)            | the released revision              |

A new row starts with no files. Promoting `branchId` does nothing about this: the
rows still point at the version that was superseded, so the part's CAD and
attachments simply stop appearing. Each of these steps therefore calls
`FileService.copyFilesToItem()`, the same way each already carries type-specific
data and BOM structure forward.

The revise path that promotes a working copy **in place** (the common case) needs
no copy at merge time — the released row and the working copy are the same row —
which is why the gap was invisible for so long.

**Files are copied, never moved.** The superseded version keeps owning its own
attachments; that is what lets the `SUPERSEDED` stamp mark the old revision's PDFs
without touching the new one, and what makes time travel to an earlier commit show
the files that version actually had. Copies share the source's `storagePath`
instead of duplicating bytes, which is safe because a rewrite
(`FileService.replaceContent`) always writes a fresh path and never mutates a blob
in place.

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

| Method | Endpoint                                             | Permission         | Description                                      |
| ------ | ---------------------------------------------------- | ------------------ | ------------------------------------------------ |
| POST   | `/api/v1/items/{itemId}/files/upload`                | Authenticated      | Upload files to an item                          |
| GET    | `/api/v1/items/{itemId}/files`                       | Authenticated      | List files for an item (branch-aware)            |
| GET    | `/api/v1/items/{itemId}/files/primary`               | `documents:read`   | Get primary CAD model                            |
| PUT    | `/api/v1/items/{itemId}/files/primary`               | Authenticated      | Set primary CAD model                            |
| GET    | `/api/v1/items/{itemId}/files/thumbnail`             | `documents:read`   | Get the designated thumbnail file, if any        |
| PUT    | `/api/v1/items/{itemId}/files/thumbnail`             | `documents:update` | Designate an uploaded image as the thumbnail     |
| DELETE | `/api/v1/items/{itemId}/files/thumbnail`             | `documents:update` | Clear the designation (falls back to generated)  |
| GET    | `/api/v1/items/{itemId}/thumbnail`                   | `parts:read`       | Serve the item's resolved thumbnail image        |
| GET    | `/api/v1/items/{itemId}/cad-files`                   | Authenticated      | List viewable CAD files (including related docs) |
| GET    | `/api/v1/files/{fileId}/download`                    | `documents:read`   | Download a file                                  |
| GET    | `/api/v1/files/{fileId}/content`                     | `documents:read`   | Stream a file inline for the in-app viewer       |
| GET    | `/api/v1/files/{fileId}/annotations`                 | `documents:read`   | List markup on a file                            |
| POST   | `/api/v1/files/{fileId}/annotations`                 | `documents:update` | Add markup (requires the item's checkout)        |
| PATCH  | `/api/v1/files/{fileId}/annotations/{id}`            | `documents:update` | Revise markup (author only)                      |
| DELETE | `/api/v1/files/{fileId}/annotations/{id}`            | `documents:update` | Remove markup                                    |
| POST   | `/api/v1/files/{fileId}/watermark`                   | `documents:update` | Queue a watermark stamp (202, returns a job id)  |
| POST   | `/api/v1/files/{fileId}/sign`                        | `documents:update` | Embed a signature (Advanced Auditing)            |
| GET    | `/api/v1/files/{fileId}/metadata`                    | `documents:read`   | Get file metadata                                |
| GET    | `/api/v1/files/{fileId}/versions`                    | `documents:read`   | List all versions                                |
| GET    | `/api/v1/files/{fileId}/versions/{version}/download` | `documents:read`   | Download specific version                        |
| GET    | `/api/v1/files/{fileId}/thumbnail`                   | `documents:read`   | Get file thumbnail                               |
| PATCH  | `/api/v1/files/{fileId}/category`                    | `documents:update` | Set a file's category, or null to re-detect      |
| DELETE | `/api/v1/files/{fileId}`                             | `documents:delete` | Soft-delete a file                               |

### Lock Operations

| Method | Endpoint                             | Permission         | Description                                      |
| ------ | ------------------------------------ | ------------------ | ------------------------------------------------ |
| POST   | `/api/v1/files/{fileId}/checkout`    | `documents:update` | Check out (lock) a file                          |
| POST   | `/api/v1/files/{fileId}/checkin`     | `documents:update` | Check in (unlock, optionally upload new version) |
| GET    | `/api/v1/files/{fileId}/lock-status` | `documents:read`   | Get lock status                                  |
| POST   | `/api/v1/files/batch-checkout`       | `documents:update` | Batch check out (max 100)                        |
| POST   | `/api/v1/files/batch-checkin`        | `documents:update` | Batch check in (max 100)                         |

### CAD Operations

| Method | Endpoint                         | Permission       | Description                                    |
| ------ | -------------------------------- | ---------------- | ---------------------------------------------- |
| POST   | `/api/v1/files/{fileId}/convert` | `documents:read` | Submit a CAD conversion job (STEP/IGES to STL) |

---

## Key Files

| File                                                          | Purpose                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/core/src/lib/vault/services/FileService.ts`         | Core service: upload, download, checkout, checkin, versioning, listing    |
| `packages/core/src/lib/vault/storage/types.ts`                | `VaultStorage` interface and configuration types                          |
| `packages/core/src/lib/vault/storage/local-storage.ts`        | Local filesystem storage implementation                                   |
| `packages/core/src/lib/vault/storage/s3-storage.ts`           | S3-compatible storage implementation                                      |
| `packages/core/src/lib/vault/storage/storage-factory.ts`      | Factory for creating storage instances from config                        |
| `packages/core/src/lib/vault/utils/file-utils.ts`             | File validation, hashing, category detection, path generation             |
| `packages/core/src/lib/vault/file-categories.ts`              | Shared category vocabulary: labels, badges, filter options                |
| `packages/core/src/lib/vault/preview.ts`                      | Shared preview allowlist: which formats render in-app, and as what        |
| `packages/core/src/lib/db/schema/vault.ts`                    | Database schema: `vault_files` and `vault_file_history` tables            |
| `packages/core/src/components/vault/FileList.tsx`             | UI component: file listing with lock status and actions                   |
| `packages/core/src/components/vault/PdfViewer.tsx`            | UI component: pdf.js viewer (code-split; not exported from the barrel)    |
| `packages/core/src/components/vault/FilePreview.tsx`          | UI component: fetches bytes and mounts the viewer for the format          |
| `packages/core/src/components/vault/SvgViewer.tsx`            | UI component: vector drawing viewer — zoom, pan, rotate, fullscreen       |
| `packages/core/src/components/vault/viewer-controls.ts`       | Zoom stops and fullscreen state shared by the PDF and SVG viewers         |
| `packages/core/src/components/vault/FilePreviewDialog.tsx`    | UI component: preview one file in a dialog, opened from `FileList`        |
| `packages/core/src/components/vault/ItemFilePreviewPanel.tsx` | UI component: in-page preview of an item's files (Documents' Preview tab) |
| `packages/core/src/components/vault/PdfAnnotationLayer.tsx`   | UI component: the markup surface over one rendered PDF page               |
| `packages/core/src/components/vault/useFileMarkup.tsx`        | Markup state, mutations, and the comment/label prompt                     |
| `packages/core/src/components/vault/FileCategoryMenu.tsx`     | UI component: category picker for correcting a file's category            |
| `packages/core/src/components/vault/FileUploadZone.tsx`       | UI component: drag-and-drop file upload                                   |
| `packages/core/src/server/routes/files.ts`                    | API route handlers for all file operations                                |
| `packages/core/src/server/routes/items.ts`                    | API route handlers for item-scoped file operations                        |
