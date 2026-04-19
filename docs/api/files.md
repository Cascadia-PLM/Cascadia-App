# Files API

The Files API manages the vault file system in Cascadia PLM. It provides file upload, download, versioning, check-out/check-in, and lock management for CAD files, documents, and other binary assets.

## Endpoints Overview

| Method | Endpoint                          | Description             |
| ------ | --------------------------------- | ----------------------- |
| GET    | `/api/files`                      | List all files          |
| DELETE | `/api/files/:fileId`              | Delete a file           |
| GET    | `/api/files/:fileId/download`     | Download a file         |
| GET    | `/api/files/:fileId/metadata`     | Get file metadata       |
| GET    | `/api/files/:fileId/versions`     | List file versions      |
| POST   | `/api/files/:fileId/checkout`     | Check out a file        |
| POST   | `/api/files/:fileId/checkin`      | Check in a file         |
| GET    | `/api/files/:fileId/lock-status`  | Get file lock status    |
| POST   | `/api/files/batch-checkout`       | Batch file checkout     |
| POST   | `/api/files/batch-checkin`        | Batch file checkin      |
| GET    | `/api/items/:itemId/files`        | List files for an item  |
| POST   | `/api/items/:itemId/files/upload` | Upload files to an item |

## List Files

```
GET /api/files
```

Lists all files in the vault. Auth required.

### Query Parameters

| Parameter | Type    | Default | Description     |
| --------- | ------- | ------- | --------------- |
| `limit`   | integer | 100     | Maximum results |

### Response

```json
{
  "data": {
    "files": [
      {
        "id": "file-uuid",
        "originalFileName": "motor_housing.step",
        "mimeType": "model/step",
        "fileSize": 2048576,
        "version": 3,
        "itemId": "item-uuid",
        "checkedOutBy": null,
        "createdAt": "2025-01-15T10:30:00.000Z"
      }
    ],
    "count": 42
  }
}
```

## Upload Files

```
POST /api/items/:itemId/files/upload
```

Upload one or more files to an item. Uses `multipart/form-data`. Auth required.

### Request

```bash
curl -X POST /api/items/ITEM_UUID/files/upload \
  -F "file1=@motor_housing.step" \
  -F "file1_description=STEP model of motor housing" \
  -F "file2=@motor_housing.pdf" \
  -F "file2_description=Drawing of motor housing" \
  -F "branchId=branch-uuid"
```

### Form Fields

| Field               | Type   | Required | Description                              |
| ------------------- | ------ | -------- | ---------------------------------------- |
| `<key>` (File)      | File   | Yes      | One or more file uploads                 |
| `<key>_description` | string | No       | Description for each file (matching key) |
| `branchId`          | UUID   | No       | Branch context for version tracking      |

### Response

**Status:** `201 Created`

```json
{
  "success": true,
  "files": [
    {
      "id": "new-file-uuid",
      "originalFileName": "motor_housing.step",
      "mimeType": "model/step",
      "fileSize": 2048576,
      "version": 1
    }
  ],
  "count": 1
}
```

## Download File

```
GET /api/files/:fileId/download
```

Downloads a file's binary content. Requires `documents.read` permission. Checks design access through the file's parent item.

### Response

Returns the raw file content with appropriate headers:

```
Content-Type: model/step
Content-Disposition: attachment; filename="motor_housing.step"
Content-Length: 2048576
X-Content-Type-Options: nosniff
```

For files larger than 10 MB, the response is streamed.

### Example

```bash
curl -O /api/files/FILE_UUID/download
```

## File Metadata

```
GET /api/files/:fileId/metadata
```

Returns file metadata without downloading the content. Requires `documents.read` permission.

### Response

```json
{
  "data": {
    "file": {
      "id": "file-uuid",
      "originalFileName": "motor_housing.step",
      "mimeType": "model/step",
      "fileSize": 2048576,
      "version": 3,
      "itemId": "item-uuid",
      "checkedOutBy": null,
      "checkedOutAt": null,
      "storagePath": "vault/ab/cd/file-uuid",
      "checksum": "sha256:abc123...",
      "createdAt": "2025-01-15T10:30:00.000Z",
      "modifiedAt": "2025-01-16T14:00:00.000Z"
    }
  }
}
```

## File Versions

```
GET /api/files/:fileId/versions
```

Lists all versions of a file. Requires `documents.read` permission.

### Response

```json
{
  "data": {
    "versions": [
      {
        "id": "version-uuid-3",
        "version": 3,
        "originalFileName": "motor_housing.step",
        "fileSize": 2148576,
        "createdAt": "2025-01-16T14:00:00.000Z",
        "createdBy": "user-uuid"
      },
      {
        "id": "version-uuid-2",
        "version": 2,
        "originalFileName": "motor_housing.step",
        "fileSize": 2048576,
        "createdAt": "2025-01-15T10:30:00.000Z",
        "createdBy": "user-uuid"
      }
    ],
    "totalVersions": 3
  }
}
```

## Delete File

```
DELETE /api/files/:fileId
```

Soft-deletes a file. Requires `documents.delete` permission.

### Response

```json
{
  "data": {
    "success": true,
    "message": "File deleted successfully"
  }
}
```

## List Item Files

```
GET /api/items/:itemId/files
```

Lists all files associated with an item. Supports branch-aware file listing. Auth required.

### Query Parameters

| Parameter      | Type | Description                              |
| -------------- | ---- | ---------------------------------------- |
| `branchId`     | UUID | Branch context for version-aware listing |
| `mainBranchId` | UUID | Main branch ID to include baseline files |

### Response

```json
{
  "data": {
    "files": [...],
    "count": 3
  }
}
```

## File Check-Out

```
POST /api/files/:fileId/checkout
```

Checks out a file for exclusive editing. Requires `documents.update` permission. Prevents other users from modifying the file until checked in.

### Response

```json
{
  "data": {
    "success": true,
    "message": "File checked out successfully"
  }
}
```

### Errors

| Code                 | Status | Description                                 |
| -------------------- | ------ | ------------------------------------------- |
| `RESOURCE_LOCKED`    | 423    | File is already checked out by another user |
| `RESOURCE_NOT_FOUND` | 404    | File not found                              |

## File Check-In

```
POST /api/files/:fileId/checkin
```

Checks in a file, optionally uploading a new version. Requires `documents.update` permission.

### Without New Version (unlock only)

```bash
curl -X POST /api/files/FILE_UUID/checkin
```

Response:

```json
{
  "data": {
    "success": true,
    "message": "File checked in successfully"
  }
}
```

### With New Version

```bash
curl -X POST /api/files/FILE_UUID/checkin \
  -F "file=@motor_housing_v2.step" \
  -F "description=Updated cooling channels"
```

Response:

```json
{
  "data": {
    "success": true,
    "message": "File checked in with new version",
    "newVersion": {
      "id": "new-version-uuid",
      "version": 4,
      "originalFileName": "motor_housing_v2.step",
      "fileSize": 2248576
    }
  }
}
```

## File Lock Status

```
GET /api/files/:fileId/lock-status
```

Returns the current lock/checkout status for a file. Requires `documents.read` permission. Checks design access through the file's parent item.

### Response (Unlocked)

```json
{
  "data": {
    "isLocked": false
  }
}
```

### Response (Locked)

```json
{
  "data": {
    "isLocked": true,
    "lockType": "file_lock",
    "lockedBy": {
      "id": "user-uuid",
      "name": "John Doe",
      "email": "john@example.com"
    },
    "lockedAt": "2025-01-15T10:30:00.000Z",
    "scope": "file"
  }
}
```

## Batch File Checkout

```
POST /api/files/batch-checkout
```

Check out multiple files at once. Useful for CAD assemblies. Requires `documents.update` permission. Limited to 100 files per batch.

### Request Body

```json
{
  "fileIds": ["file-uuid-1", "file-uuid-2", "file-uuid-3"]
}
```

### Response

Returns `201` (all succeeded), `207` (partial success), or `400` (all failed):

```json
{
  "data": {
    "checkedOut": [
      {
        "fileId": "file-uuid-1",
        "fileName": "assembly.step",
        "checkedOutAt": "2025-01-15T10:30:00.000Z"
      }
    ],
    "errors": [
      {
        "fileId": "file-uuid-2",
        "error": "Failed to checkout file",
        "details": "File is already checked out by another user"
      }
    ]
  }
}
```

## Batch File Checkin

```
POST /api/files/batch-checkin
```

Check in multiple files at once (unlock without new versions). Requires `documents.update` permission. Limited to 100 files per batch.

### Request Body

```json
{
  "fileIds": ["file-uuid-1", "file-uuid-2"]
}
```

### Response

Returns `200` (all succeeded), `207` (partial success), or `400` (all failed):

```json
{
  "data": {
    "checkedIn": [
      {
        "fileId": "file-uuid-1",
        "fileName": "assembly.step"
      }
    ],
    "errors": []
  }
}
```

Note: Batch checkin only unlocks files. To upload new file versions, use the individual file checkin endpoint (`POST /api/files/:fileId/checkin`) with `multipart/form-data`.

## Lock Hierarchy

Cascadia provides three complementary locking systems that work together to manage concurrent access.

### Lock Types

| Lock Type     | Purpose                                     | Scope                           | API Endpoints                                  |
| ------------- | ------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| **Checkout**  | Branch-scoped edit session for PLM workflow | Item on a specific branch       | `/api/items/:id/checkout`                      |
| **Item Lock** | Exclusive edit rights for concurrent access | Single item across all branches | `/api/items/:id/lock`, `/api/items/:id/unlock` |
| **File Lock** | CAD-specific file lock for external tools   | Individual file                 | `/api/files/:fileId/lock-status`               |

### Lock Precedence

```
Item Lock (highest - blocks ALL operations)
  |
  +-- Checkout (blocks checkout on same branch only)
        |
        +-- File Lock (blocks file operations only)
```

**Rules:**

1. If an item has an **item lock**, no checkouts or edits are allowed on any branch.
2. If an item is **checked out** on a branch, other users cannot checkout that item on the same branch. Edits on other branches are unaffected.
3. If a file has a **file lock**, the file cannot be modified, but item metadata changes may still be allowed.

### Item Lock API

```
POST /api/items/:id/lock      # Lock an item
POST /api/items/:id/unlock    # Unlock an item
GET  /api/items/:id/lock-status  # Get lock status
```

#### Lock Request

```bash
curl -X POST /api/items/ITEM_UUID/lock \
  -H "Content-Type: application/json" \
  -d '{ "force": false }'
```

The `force` option allows overriding another user's lock (intended for administrators).

#### Lock Status Response

```json
{
  "data": {
    "lockStatus": {
      "isLocked": true,
      "lockType": "lock",
      "lockedBy": {
        "id": "user-uuid",
        "name": "John Doe",
        "email": "john@example.com"
      },
      "lockedAt": "2025-01-15T10:30:00.000Z",
      "lockedFor": 45,
      "scope": "item"
    }
  }
}
```

The `lockedFor` field shows lock duration in minutes.

### Item Checkout API

```
POST   /api/items/:id/checkout   # Check out item to branch
GET    /api/items/:id/checkout   # Get checkout status
DELETE /api/items/:id/checkout   # Cancel checkout
POST   /api/items/:id/checkin    # Check in item
```

All checkout operations require a `branchId` parameter.

#### Checkout Request

```bash
curl -X POST /api/items/ITEM_UUID/checkout \
  -H "Content-Type: application/json" \
  -d '{ "branchId": "branch-uuid" }'
```

#### Batch Item Checkout

```bash
curl -X POST /api/items/batch-checkout \
  -H "Content-Type: application/json" \
  -d '{ "itemIds": ["uuid1", "uuid2"], "branchId": "branch-uuid" }'
```

### Lock Error Codes

| Code                | Message                               | Cause                                 |
| ------------------- | ------------------------------------- | ------------------------------------- |
| `CHECKOUT_CONFLICT` | Item is already checked out by {user} | Another user has the item checked out |
| `ITEM_LOCKED`       | Item is locked by {user}              | Item has a global lock                |
| `FILE_LOCKED`       | File is locked by {user}              | File has an exclusive lock            |
| `NOT_CHECKED_OUT`   | Item is not checked out               | Trying to checkin without checkout    |
| `NOT_YOUR_CHECKOUT` | You do not have this item checked out | Different user's checkout             |

### CAD Integration Workflow

Recommended workflow for CAD tools integrating with Cascadia:

1. **Start editing session** -- batch checkout items:

   ```
   POST /api/items/batch-checkout
   ```

2. **Make changes locally in CAD tool**

3. **Save changes to Cascadia** -- upload files and update metadata:

   ```
   POST /api/items/:id/files/upload
   PUT /api/items/:id
   ```

4. **End editing session** -- batch checkin:
   ```
   POST /api/items/batch-checkin
   ```

### Best Practices

1. **Use checkout for normal PLM workflow** -- it is the least restrictive and most common pattern.
2. **Use item locks sparingly** -- they block all users globally.
3. **Always release locks** -- implement automatic release on session timeout for external tools.
4. **Batch operations for CAD** -- use batch checkout/checkin for assembly edits.
5. **Check lock status first** -- before attempting modifications, verify lock status to provide better UX.
