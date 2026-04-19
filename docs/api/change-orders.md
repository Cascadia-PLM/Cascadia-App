# Change Orders API

The Change Orders (ECO) API manages Engineering Change Orders, which are the primary mechanism for making controlled changes to released items in Cascadia PLM. Each ECO gets its own isolated branch, and all state transitions go through a single workflow transition endpoint.

## Key Concept: ECO-as-Branch

When an ECO is created, Cascadia automatically creates a Git-style branch. Items are checked out to the ECO branch, modified in isolation, and merged back to main when the ECO is approved and released. Revision letters are assigned only at merge time.

## Endpoints Overview

| Method | Endpoint                                              | Description                 |
| ------ | ----------------------------------------------------- | --------------------------- |
| GET    | `/api/change-orders/:id`                              | Get a change order          |
| PUT    | `/api/change-orders/:id`                              | Update a change order       |
| DELETE | `/api/change-orders/:id`                              | Delete a change order       |
| GET    | `/api/change-orders/editable`                         | List editable change orders |
| GET    | `/api/change-orders/:id/summary`                      | Get ECO summary             |
| GET    | `/api/change-orders/:id/affected-items`               | List affected items         |
| POST   | `/api/change-orders/:id/affected-items`               | Add affected items          |
| DELETE | `/api/change-orders/:id/affected-items`               | Remove affected item        |
| POST   | `/api/change-orders/:id/checkout`                     | Checkout item to ECO        |
| GET    | `/api/change-orders/:id/workflow`                     | Get workflow instance       |
| POST   | `/api/change-orders/:id/workflow`                     | Start workflow              |
| GET    | `/api/change-orders/:id/workflow/transition`          | Get available transitions   |
| POST   | `/api/change-orders/:id/workflow/transition`          | Execute a transition        |
| POST   | `/api/change-orders/:id/workflow/validate-transition` | Validate a transition       |
| GET    | `/api/change-orders/:id/workflow/structure`           | Get workflow structure      |
| PUT    | `/api/change-orders/:id/workflow/structure`           | Update workflow structure   |
| GET    | `/api/change-orders/:id/workflow/history`             | Get transition history      |
| GET    | `/api/change-orders/:id/approvals`                    | Get approval status         |
| POST   | `/api/change-orders/:id/approvals`                    | Submit approval vote        |
| GET    | `/api/change-orders/:id/impact-assessment`            | Get impact report           |
| POST   | `/api/change-orders/:id/impact-assessment`            | Run impact assessment       |
| GET    | `/api/change-orders/:id/conflicts`                    | Detect merge conflicts      |
| GET    | `/api/change-orders/:id/release`                      | Preview release/merge       |

## Create Change Order

Change orders are created via the generic items endpoint:

```
POST /api/items
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

A workflow is auto-started for the ECO based on its `changeType`.

## Get Change Order

```
GET /api/change-orders/:id
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
      "state": "In Review",
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
PUT /api/change-orders/:id
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
GET /api/change-orders/editable
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
        "state": "In Work"
      }
    ]
  }
}
```

## ECO Summary

```
GET /api/change-orders/:id/summary
```

Returns a comprehensive summary of the ECO across all affected designs. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "changeOrder": { ... },
    "products": [
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
GET /api/change-orders/:id/affected-items
```

Returns all items affected by this ECO. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "affectedItems": [
      {
        "id": "affected-item-uuid",
        "changeOrderId": "eco-uuid",
        "affectedItemId": "item-uuid",
        "changeAction": "modify",
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
POST /api/change-orders/:id/affected-items
```

Add one or more items to the ECO's affected items list. Requires `change_orders.update` permission.

#### Single Item

```json
{
  "affectedItemId": "item-uuid",
  "changeAction": "modify"
}
```

#### Batch

```json
{
  "items": [
    { "affectedItemId": "item-uuid-1", "changeAction": "modify" },
    { "affectedItemId": "item-uuid-2", "changeAction": "add" }
  ]
}
```

**Status:** `201 Created`

### Remove Affected Item

```
DELETE /api/change-orders/:id/affected-items?itemId=AFFECTED_ITEM_UUID
```

Removes an affected item record. Requires `change_orders.update` permission.

## Checkout Item to ECO

```
POST /api/change-orders/:id/checkout
```

Checks out an existing item onto the ECO's branch, creating a branch copy for modification. Requires `change_orders.update` permission.

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

## Workflow Transitions

**All ECO state changes go through a single endpoint.** There are no separate `/submit`, `/approve`, `/reject`, or `/actions` routes.

### Get Available Transitions

```
GET /api/change-orders/:id/workflow/transition
```

Returns transitions available from the current state, evaluating guards and role requirements. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "transitions": [
      {
        "id": "transition-uuid",
        "name": "Submit for Review",
        "fromStateId": "in-work",
        "toStateId": "in-review",
        "guards": [],
        "allowed": true
      },
      {
        "id": "transition-uuid-2",
        "name": "Approve",
        "fromStateId": "in-review",
        "toStateId": "approved",
        "guards": ["requires_approval"],
        "allowed": false
      }
    ]
  }
}
```

### Execute a Transition

```
POST /api/change-orders/:id/workflow/transition
```

Executes a workflow transition. Requires `change_orders.update` permission.

**When transitioning to a final state** (e.g., "Approved" with `isFinal: true`), this endpoint automatically:

1. Executes the workflow state transition
2. Triggers `close()` which merges the ECO branch to main
3. Assigns revision letters to affected items

### Request Body

| Field       | Type   | Required | Description         |
| ----------- | ------ | -------- | ------------------- |
| `toStateId` | string | Yes      | Target state ID     |
| `comments`  | string | No       | Transition comments |

```json
{
  "toStateId": "in-review",
  "comments": "Ready for review. All affected items updated."
}
```

### Response (Standard Transition)

```json
{
  "data": {
    "success": true,
    "fromState": "in-work",
    "toState": "in-review"
  }
}
```

### Response (Final State -- Triggers Release)

```json
{
  "data": {
    "success": true,
    "fromState": "in-review",
    "toState": "approved",
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
POST /api/change-orders/:id/workflow/validate-transition
```

Validates a transition without executing it. Returns preview of what would happen, including lifecycle effects on affected items. Requires `change_orders.read` permission.

### Request Body

```json
{
  "toStateId": "approved"
}
```

### Response

```json
{
  "data": {
    "valid": true,
    "transitionName": "Approve",
    "fromState": "in-review",
    "toState": "approved",
    "workflowGuardErrors": [],
    "lifecycleEffectErrors": [],
    "affectedItemsPreview": [
      {
        "itemId": "item-uuid",
        "itemNumber": "PRT-001",
        "changeAction": "modify",
        "currentState": "In Review",
        "predictedTransitions": [
          {
            "fromState": "In Review",
            "toState": "Released",
            "lifecycleName": "Standard Part Lifecycle"
          }
        ]
      }
    ]
  }
}
```

## Workflow Instance

### Get Workflow

```
GET /api/change-orders/:id/workflow
```

Returns the workflow instance and its effective definition. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "instance": {
      "id": "instance-uuid",
      "workflowDefinitionId": "def-uuid",
      "itemId": "eco-uuid",
      "currentState": "in-review",
      "startedAt": "2025-01-15T10:30:00.000Z"
    },
    "definition": {
      "id": "def-uuid",
      "name": "ECO Approval Workflow",
      "states": [...],
      "transitions": [...]
    },
    "isFlexible": false
  }
}
```

### Start Workflow

```
POST /api/change-orders/:id/workflow
```

Manually starts a workflow for a change order (normally auto-started on creation). Requires `change_orders.update` permission.

### Request Body

```json
{
  "workflowDefinitionId": "def-uuid"
}
```

**Status:** `201 Created`

## Workflow Structure

```
GET /api/change-orders/:id/workflow/structure
```

Returns the effective workflow structure, including any instance-level customizations for flexible workflows.

```
PUT /api/change-orders/:id/workflow/structure
```

Updates the workflow structure for flexible workflows. Only allowed when the workflow is editable (not completed). Requires `change_orders.update` permission.

### Request Body

```json
{
  "states": [
    { "id": "draft", "name": "Draft", "isInitial": true },
    { "id": "review", "name": "Review" },
    { "id": "approved", "name": "Approved", "isFinal": true }
  ],
  "transitions": [
    { "fromStateId": "draft", "toStateId": "review", "name": "Submit" },
    { "fromStateId": "review", "toStateId": "approved", "name": "Approve" }
  ]
}
```

## Workflow History

```
GET /api/change-orders/:id/workflow/history
```

Returns the transition history for the ECO's workflow. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "history": [
      {
        "id": "entry-uuid",
        "fromState": "in-work",
        "toState": "in-review",
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
GET /api/change-orders/:id/approvals
```

Returns approval votes grouped by workflow state. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "instanceId": "instance-uuid",
    "currentState": "in-review",
    "approvals": [
      {
        "stateId": "in-review",
        "votes": [
          {
            "userId": "user-uuid",
            "vote": "approved",
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
POST /api/change-orders/:id/approvals
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
  "vote": "approved",
  "comments": "Design review complete, changes look correct"
}
```

**Status:** `201 Created`

## Impact Assessment

### Get Impact Report

```
GET /api/change-orders/:id/impact-assessment
```

Returns the previously-generated impact report. Requires `change_orders.read` permission.

### Run Impact Assessment

```
POST /api/change-orders/:id/impact-assessment
```

Runs an impact assessment to analyze what items are affected by the ECO, traversing the BOM tree. Requires `change_orders.update` permission.

### Request Body

| Field                 | Type    | Default | Description                 |
| --------------------- | ------- | ------- | --------------------------- |
| `maxDepth`            | integer | 15      | Maximum BOM traversal depth |
| `includeDocuments`    | boolean | true    | Include related documents   |
| `includeCrossChanges` | boolean | true    | Include cross-ECO impacts   |

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
GET /api/change-orders/:id/conflicts
```

Detects merge conflicts for the ECO, including field-level conflicts and cross-ECO conflicts. Results are enriched with review status. Requires `change_orders.read` permission.

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
GET /api/change-orders/:id/release
```

Preview what would happen when the ECO is released (merged to main). Actual release is triggered by transitioning to a final workflow state. Requires `change_orders.read` permission.

### Response

```json
{
  "data": {
    "designs": [
      {
        "designId": "design-uuid",
        "designName": "Widget Assembly",
        "itemCount": 5
      }
    ],
    "totalItems": 5,
    "canRelease": true,
    "validationIssues": []
  }
}
```
