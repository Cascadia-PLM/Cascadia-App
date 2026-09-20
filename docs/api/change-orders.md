# Change Orders API

The Change Orders API manages change orders -- ECO, ECN, MCO and Deviation by change type -- the primary mechanism for controlled change to released items in Cascadia PLM. Each change order gets its own isolated branch, and every state transition goes through one endpoint on the change order's lifecycle instance.

## Key Concept: ECO-as-Branch

When a change order is created, Cascadia automatically creates a Git-style branch. Items are checked out to the change-order branch, modified in isolation, and merged back to main when the change order is approved and released. Revision letters are assigned only at merge time.

## Endpoints

This page explains behaviour; it is not an endpoint inventory. Three generated
surfaces carry that, and none of them can drift from the routes the way a
hand-written table does:

- `GET /api/docs` — the interactive Scalar UI
- `GET /openapi.json` — the live spec, regenerated from route metadata per request
- [`openapi.v1.json`](./openapi.v1.json) — the frozen v1 contract, the one external
  consumers should build against

See [the API README](./README.md) for the versioning policy that governs all three.

## Create Change Order

Change orders are created via the generic items endpoint:

```
POST /api/v1/items
```

### Request Body

```json
{
  "itemType": "ChangeOrder",
  "itemNumber": "ECO-2025-001",
  "revision": "A",
  "name": "Motor Housing Redesign",
  "changeType": "ECO",
  "priority": "high",
  "description": "Redesign motor housing for improved thermal performance",
  "reasonForChange": "Field failures due to overheating",
  "impactDescription": "Affects motor assembly and cooling subsystem",
  "riskLevel": "medium",
  "implementationDate": "2025-03-15"
}
```

### Change Order Fields

| Field                | Type   | Required | Values                              |
| -------------------- | ------ | -------- | ----------------------------------- |
| `changeType`         | enum   | Yes      | `ECO`, `ECN`, `Deviation`, `MCO`    |
| `priority`           | enum   | No       | `low`, `medium`, `high`, `critical` |
| `description`        | string | No       | Description (max 10000)             |
| `reasonForChange`    | string | No       | Reason text (max 10000)             |
| `impactDescription`  | string | No       | Impact text (max 10000)             |
| `implementationDate` | date   | No       | Target implementation date          |
| `riskLevel`          | enum   | No       | `low`, `medium`, `high`, `critical` |

Creation starts a lifecycle instance for the change order, from the Driving definition its `changeType` maps to.

## Get Change Order

```
GET /api/v1/change-orders/:id
```

Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "changeOrder": {
      "id": "eco-uuid",
      "itemNumber": "ECO-2025-001",
      "revision": "A",
      "name": "Motor Housing Redesign",
      "itemType": "ChangeOrder",
      "state": "Draft",
      "changeType": "ECO",
      "priority": "high",
      "reasonForChange": "Field failures due to overheating",
      "impactDescription": "Affects motor assembly and cooling subsystem",
      "riskLevel": "medium",
      "createdBy": "user-uuid",
      "createdAt": "2025-01-15T10:30:00.000Z"
    }
  }
}
```

## Update Change Order

```
PUT /api/v1/change-orders/:id
```

Requires `change_orders.update` permission. All fields are optional (PATCH-style).

### Request Body

```json
{
  "name": "Motor Housing Redesign v2",
  "priority": "critical",
  "riskLevel": "high"
}
```

## List Editable Change Orders

```
GET /api/v1/change-orders/editable
```

Returns change orders that can still accept new affected items (scope is not yet locked). Requires `change_orders.read` permission.

### Query Parameters

| Parameter  | Type | Description      |
| ---------- | ---- | ---------------- |
| `designId` | UUID | Filter by design |

### Response

```json
{
  "data": {
    "changeOrders": [
      {
        "id": "eco-uuid",
        "itemNumber": "ECO-2025-001",
        "name": "Motor Housing Redesign",
        "state": "Draft"
      }
    ]
  }
}
```

## Change-Order Summary

```
GET /api/v1/change-orders/:id/summary
```

Returns a comprehensive summary of the change order across all affected designs. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "changeOrder": { ... },
    "designs": [
      {
        "designId": "design-uuid",
        "designName": "Widget Assembly",
        "itemsAffected": 5
      }
    ],
    "totalItemsAffected": 5,
    "canSubmit": true,
    "canRelease": false
  }
}
```

## Affected Items

### List Affected Items

```
GET /api/v1/change-orders/:id/affected-items
```

Returns all items affected by this change order. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "affectedItems": [
      {
        "id": "affected-item-uuid",
        "changeOrderId": "eco-uuid",
        "affectedItemId": "item-uuid",
        "changeAction": "revise",
        "initialRevisionOverride": null,
        "affectedItemDetails": {
          "itemNumber": "PRT-001",
          "name": "Motor Housing",
          "revision": "A",
          "state": "Released"
        }
      }
    ]
  }
}
```

### Add Affected Items

```
POST /api/v1/change-orders/:id/affected-items
```

Add one or more items to the change order's affected items list. Requires `change_orders.update` permission.

#### Single Item

```json
{
  "affectedItemId": "item-uuid",
  "changeAction": "revise"
}
```

#### Batch

```json
{
  "items": [
    { "affectedItemId": "item-uuid-1", "changeAction": "revise" },
    { "affectedItemId": "item-uuid-2", "changeAction": "release" }
  ]
}
```

**Status:** `201 Created`

### Set an Imported Initial Revision

```
PATCH /api/v1/change-orders/:id/affected-items/:affectedItemId/initial-revision
```

Administrators can set the formal revision that an unreleased item receives on
its first `release`. This is intended for importing an existing baseline, for
example assigning `R3` to one item while other items use the lifecycle's normal
initial revision. The value must match that item's configured revision scheme.

```json
{ "revision": "R3" }
```

Use `{ "revision": null }` to clear the override and return to the lifecycle
default. The operation is rejected for actions other than `release`, after the
change-order scope is locked, or when any formal revision already exists in the
item's lineage. The release preview and merge both revalidate and use this
value; `targetRevision` remains a presentation prediction.

### Remove Affected Item

```
DELETE /api/v1/change-orders/:id/affected-items?itemId=AFFECTED_ITEM_UUID
```

Removes an affected item record. Requires `change_orders.update` permission.

## Checkout Item to a Change Order

```
POST /api/v1/change-orders/:id/checkout
```

Checks out an existing item onto the change order's branch, creating a branch copy for modification. Requires `change_orders.update` permission.

### Request Body

```json
{
  "itemId": "item-uuid"
}
```

### Response

**Status:** `201 Created`

```json
{
  "data": {
    "branchItem": {
      "id": "branch-item-uuid",
      "itemMasterId": "master-uuid",
      "branchId": "eco-branch-uuid",
      "changeType": "modified"
    },
    "branch": {
      "id": "eco-branch-uuid",
      "name": "eco/ECO-2025-001"
    }
  }
}
```

## Transitions

**All change-order state changes go through a single endpoint.** There are no separate `/submit`, `/approve`, `/reject`, or `/actions` routes.

### Get Available Transitions

```
GET /api/v1/change-orders/:id/workflow/transition
```

Returns transitions available from the current state, evaluating guards and role requirements. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "transitions": [
      {
        "transition": {
          "id": "t1",
          "name": "Submit for Review",
          "fromStateId": "Draft",
          "toStateId": "InReview",
          "guards": []
        },
        "canTransition": true,
        "guardResults": []
      },
      {
        "transition": {
          "id": "t2",
          "name": "Approve",
          "fromStateId": "InReview",
          "toStateId": "Approved",
          "guards": [
            {
              "id": "guard-uuid",
              "name": "Approver only",
              "type": "user_role",
              "config": { "requiredRoles": ["Approver"] },
              "errorMessage": "Only an Approver can approve"
            }
          ]
        },
        "canTransition": false,
        "guardResults": [
          {
            "guardId": "guard-uuid",
            "guardName": "Approver only",
            "passed": false,
            "errorMessage": "Only an Approver can approve"
          }
        ]
      }
    ]
  }
}
```

### Execute a Transition

```
POST /api/v1/change-orders/:id/workflow/transition
```

Executes a transition on the change order's lifecycle instance. Requires `change_orders.update` permission.

**When transitioning to a final state** (e.g., "Approved" with `isFinal: true`), this endpoint automatically:

1. Executes the transition
2. Triggers `close()` which merges the change-order branch to main
3. Assigns revision letters to affected items

### Request Body

| Field       | Type   | Required | Description         |
| ----------- | ------ | -------- | ------------------- |
| `toStateId` | string | Yes      | Target state ID     |
| `comments`  | string | No       | Transition comments |

```json
{
  "toStateId": "InReview",
  "comments": "Ready for review. All affected items updated."
}
```

### Response (Standard Transition)

```json
{
  "data": {
    "success": true,
    "fromState": "Draft",
    "toState": "InReview"
  }
}
```

### Response (Final State -- Triggers Release)

```json
{
  "data": {
    "success": true,
    "fromState": "InReview",
    "toState": "Approved",
    "mergeResult": {
      "mergedDesigns": 1,
      "mergedItems": 5,
      "revisionsAssigned": [
        { "itemNumber": "PRT-001", "newRevision": "B" },
        { "itemNumber": "PRT-002", "newRevision": "C" }
      ]
    }
  }
}
```

### Validate a Transition

```
POST /api/v1/change-orders/:id/workflow/validate-transition
```

Validates a transition without executing it. Returns a preview of what would happen, including the change actions the release would apply to affected items. Requires `change_orders.read` permission.

### Request Body

```json
{
  "toStateId": "Approved"
}
```

### Response

```json
{
  "data": {
    "valid": true,
    "transitionName": "Approve",
    "fromState": "InReview",
    "toState": "Approved",
    "workflowGuardErrors": [],
    "affectedItemErrors": [],
    "affectedItemsPreview": [
      {
        "itemId": "item-uuid",
        "itemNumber": "PRT-001",
        "changeAction": "release",
        "currentState": "Draft",
        "predictedTransitions": [
          {
            "fromState": "Draft",
            "toState": "Released",
            "lifecycleName": "Standard Part Lifecycle"
          }
        ]
      }
    ]
  }
}
```

## Lifecycle Instance

### Get the Instance

```
GET /api/v1/change-orders/:id/workflow
```

Returns the lifecycle instance and its effective definition. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "instance": {
      "id": "instance-uuid",
      "workflowDefinitionId": "def-uuid",
      "itemId": "eco-uuid",
      "currentState": "InReview",
      "startedAt": "2025-01-15T10:30:00.000Z"
    },
    "definition": {
      "id": "def-uuid",
      "name": "Change Order - Standard",
      "states": [...],
      "transitions": [...]
    },
    "isFlexible": false
  }
}
```

### Start an Instance

```
POST /api/v1/change-orders/:id/workflow
```

Starts a lifecycle instance for a change order that lost its instance -- creation starts one -- and accepts only a Driving definition. Requires `change_orders.update` permission.

### Request Body

```json
{
  "workflowDefinitionId": "def-uuid"
}
```

**Status:** `201 Created`

## Instance Structure

```
GET /api/v1/change-orders/:id/workflow/structure
```

Returns the effective instance structure, including any instance-level customizations for flexible definitions.

```
PUT /api/v1/change-orders/:id/workflow/structure
```

Updates the instance structure for flexible definitions. Only allowed while the instance is editable (flexible and not completed). Requires `change_orders.update` permission.

### Request Body

```json
{
  "states": [
    { "id": "draft", "name": "Draft", "isInitial": true },
    { "id": "review", "name": "Review" },
    { "id": "Approved", "name": "Approved", "isFinal": true }
  ],
  "transitions": [
    { "fromStateId": "draft", "toStateId": "review", "name": "Submit" },
    { "fromStateId": "review", "toStateId": "Approved", "name": "Approve" }
  ]
}
```

Instance-level transitions may carry `"approvalRequirement": { "requiredCount": n }` — the transition is then blocked until `n` distinct users hold an active approved vote at the source state (enforced; composes with named approvers).

## Instance-Level State Approvers

```
GET /api/v1/change-orders/:id/workflow/states/:stateId/approvers
```

Returns the instance-level approvers for one state (the editable set for flexible definitions; definition-level approvers are reported through the `/approvals` endpoints as part of the merged status). Requires `change_orders.read` permission.

```
PUT /api/v1/change-orders/:id/workflow/states/:stateId/approvers
```

Replaces the instance-level approver set for a state. Same editability gate as the structure endpoint (flexible and not completed); the state must exist on the instance's effective structure. Requires `change_orders.update` permission.

### Request Body

```json
{
  "approvers": [
    { "type": "user", "id": "user-uuid", "isRequired": true },
    { "type": "role", "id": "role-uuid", "isRequired": false }
  ]
}
```

Approval gating uses the union of definition-level and instance-level approvers; every required approver must hold an active approved vote before the instance can leave the state.

## Transition History

```
GET /api/v1/change-orders/:id/workflow/history
```

Returns the transition history for the change order's lifecycle instance. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "history": [
      {
        "id": "entry-uuid",
        "fromState": "Draft",
        "toState": "InReview",
        "transitionedBy": "user-uuid",
        "transitionedAt": "2025-01-16T14:00:00.000Z",
        "comments": "Ready for review"
      }
    ]
  }
}
```

## Approvals

### Get Approval Status

```
GET /api/v1/change-orders/:id/approvals
```

Returns approval votes grouped by lifecycle state. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "instanceId": "instance-uuid",
    "currentState": "InReview",
    "approvals": [
      {
        "stateId": "InReview",
        "votes": [
          {
            "userId": "user-uuid",
            "vote": "Approved",
            "comments": "Looks good",
            "votedAt": "2025-01-16T15:00:00.000Z"
          }
        ],
        "required": 2,
        "received": 1
      }
    ],
    "canApprove": true
  }
}
```

### Submit Approval Vote

```
POST /api/v1/change-orders/:id/approvals
```

Submit an approval or rejection vote for the current state. Requires `change_orders.update` permission.

### Request Body

| Field      | Type   | Required | Values                           |
| ---------- | ------ | -------- | -------------------------------- |
| `vote`     | string | Yes      | `approved` or `rejected`         |
| `roleId`   | UUID   | No       | Role ID for role-based approvals |
| `comments` | string | No       | Vote comments                    |

```json
{
  "vote": "Approved",
  "comments": "Design review complete, changes look correct"
}
```

**Status:** `201 Created`

#### Digital signatures (Advanced Auditing package)

On instances licensed for [Advanced Auditing](../features/advanced-auditing.md),
every vote must be digitally signed and two additional fields apply:

| Field              | Type   | Required              | Description                                                           |
| ------------------ | ------ | --------------------- | --------------------------------------------------------------------- |
| `password`         | string | Only on password path | Account password. Not needed when a CAC/PIV certificate is presented. |
| `signatureMeaning` | string | No                    | Overrides the default meaning (`Approved by` / `Rejected by`)         |

When the approver's smart card is presented on the connection, the certificate
supplies the credential and no password is sent. Call
`GET /api/v1/signatures/capability` first to learn which path applies.

The response gains a `signature` object alongside `vote`, and the vote plus its
signature are written in one transaction — a failed signature leaves no vote
behind.

| Error code                         | HTTP | Meaning                                                        |
| ---------------------------------- | ---- | -------------------------------------------------------------- |
| `SIGNATURE_REQUIRED`               | 422  | Signing context missing                                        |
| `SIGNATURE_INVALID`                | 401  | Bad password, or an expired/untrusted/revoked certificate      |
| `SIGNATURE_CREDENTIAL_UNAVAILABLE` | 422  | Policy demands a credential the request cannot offer           |
| `SIGNATURE_IDENTITY_MISMATCH`      | 403  | Certificate belongs to a different account, or is not enrolled |

Unlicensed instances ignore both fields and behave exactly as documented above.

## Impact Assessment

### Get Impact Report

```
GET /api/v1/change-orders/:id/impact-assessment
```

Returns the previously-generated impact report. Requires `change_orders.read` permission.

### Run Impact Assessment

```
POST /api/v1/change-orders/:id/impact-assessment
```

Runs an impact assessment to analyze what items are affected by the change order, traversing the BOM tree. Requires `change_orders.update` permission.

### Request Body

| Field                 | Type    | Default | Description                        |
| --------------------- | ------- | ------- | ---------------------------------- |
| `maxDepth`            | integer | 15      | Maximum BOM traversal depth        |
| `includeDocuments`    | boolean | true    | Include related documents          |
| `includeCrossChanges` | boolean | true    | Include cross-change-order impacts |

```json
{
  "maxDepth": 10,
  "includeDocuments": true,
  "includeCrossChanges": true
}
```

### Response

```json
{
  "data": {
    "impactAnalysis": {
      "changeOrderId": "eco-uuid",
      "totalImpactedItems": 12,
      "maxBOMDepth": 4,
      "directlyAffected": [...],
      "indirectlyAffected": [...],
      "crossEcoConflicts": [...]
    }
  }
}
```

## Conflict Detection

```
GET /api/v1/change-orders/:id/conflicts
```

Detects merge conflicts for the change order, including field-level conflicts and cross-change-order conflicts. Results are enriched with review status. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "conflicts": [
      {
        "id": "conflict-uuid",
        "itemId": "item-uuid",
        "fieldName": "weight",
        "severity": "warning",
        "mainValue": "2.5",
        "branchValue": "2.3",
        "otherEcoId": "other-eco-uuid",
        "isReviewed": false,
        "needsReReview": false
      }
    ],
    "summary": {
      "total": 3,
      "errors": 0,
      "warnings": 3,
      "reviewedWarnings": 1,
      "unreviewedWarnings": 2
    }
  }
}
```

## Release Preview

```
GET /api/v1/change-orders/:id/release
```

Preview what would happen when the change order is released (merged to main). Actual release is triggered by transitioning to a final state of its lifecycle. Requires `change_orders.read` permission.

Each item appears once, keyed by its master — a checked-out item is one row, not
one for the branch working copy and another for the row on main. `currentRevision`
is the revision main holds, never the branch placeholder (`-d370051d`) a working
copy carries, and `newRevision` is the letter the release will actually assign.

A change order whose lifecycle instance has finished previews nothing: `designs` is empty,
`canRelease` is `false`, and `validationIssues` says why. `alreadyReleased` is
`true` when it finished by releasing, as opposed to being cancelled.

### Response

```json
{
  "data": {
    "designs": [
      {
        "designId": "design-uuid",
        "designName": "Widget Assembly",
        "items": [
          {
            "itemId": "item-uuid",
            "itemNumber": "PN-1000",
            "currentRevision": "A",
            "newRevision": "B",
            "changeType": "modified"
          }
        ],
        "conflicts": []
      }
    ],
    "totalItems": 1,
    "canRelease": true,
    "validationIssues": [],
    "allConflicts": [],
    "alreadyReleased": false
  }
}
```
