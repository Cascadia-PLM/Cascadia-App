# Workflows API

The Workflows API manages workflow definitions and their runtime instances. Workflows define state machines that govern item lifecycle transitions and change order approval processes.

Cascadia supports two workflow categories:

- **Lifecycle** workflows -- govern item state transitions (e.g., Draft -> In Review -> Released)
- **Workflow** (approval) workflows -- govern change order approval processes (e.g., In Work -> Submitted -> Approved)

## Endpoints Overview

| Method | Endpoint                                                   | Description                  |
| ------ | ---------------------------------------------------------- | ---------------------------- |
| GET    | `/api/workflows`                                           | List workflow definitions    |
| POST   | `/api/workflows`                                           | Create a workflow definition |
| GET    | `/api/workflows/:id`                                       | Get a workflow definition    |
| PUT    | `/api/workflows/:id`                                       | Update a workflow definition |
| DELETE | `/api/workflows/:id`                                       | Delete a workflow definition |
| GET    | `/api/workflows/:id/approvers`                             | Get approvers for all states |
| GET    | `/api/workflows/:id/states/:stateId/approvers`             | Get approvers for a state    |
| POST   | `/api/workflows/:id/states/:stateId/approvers`             | Add approver to a state      |
| DELETE | `/api/workflows/:id/states/:stateId/approvers/:approverId` | Remove approver              |
| GET    | `/api/workflows/:id/validate`                              | Validate workflow definition |

For workflow instances on change orders, see the [Change Orders API](./change-orders.md).

## List Workflow Definitions

```
GET /api/workflows
```

Lists all workflow definitions with optional filtering. Auth required.

### Query Parameters

| Parameter  | Type    | Values                  | Description                   |
| ---------- | ------- | ----------------------- | ----------------------------- |
| `isActive` | string  | `true`, `false`         | Filter by active status       |
| `type`     | string  | `lifecycle`, `workflow` | Filter by definition type     |
| `limit`    | integer | 1-500                   | Max results (default 100)     |
| `offset`   | integer | 0+                      | Pagination offset (default 0) |

### Response

```json
{
  "data": {
    "workflows": [
      {
        "id": "def-uuid",
        "name": "Standard Part Lifecycle",
        "definitionType": "lifecycle",
        "workflowType": "strict",
        "description": "Standard lifecycle for manufactured parts",
        "applicableItemTypes": ["Part", "Document"],
        "states": [
          { "id": "draft", "name": "Draft", "isInitial": true },
          { "id": "in-review", "name": "In Review" },
          { "id": "released", "name": "Released", "isFinal": true }
        ],
        "transitions": [
          {
            "id": "t1",
            "name": "Submit for Review",
            "fromStateId": "draft",
            "toStateId": "in-review"
          },
          {
            "id": "t2",
            "name": "Release",
            "fromStateId": "in-review",
            "toStateId": "released"
          }
        ],
        "isActive": true,
        "createdAt": "2025-01-01T00:00:00.000Z"
      }
    ],
    "total": 5
  }
}
```

### Example

```bash
# List all active lifecycle workflows
curl /api/workflows?isActive=true&type=lifecycle

# List all approval workflows
curl /api/workflows?type=workflow
```

## Create Workflow Definition

```
POST /api/workflows
```

Creates a new workflow definition. Requires `workflows.create` permission.

### Request Body

| Field                 | Type    | Required | Description                                   |
| --------------------- | ------- | -------- | --------------------------------------------- |
| `name`                | string  | Yes      | Workflow name                                 |
| `definitionType`      | string  | No       | `lifecycle` (default) or `workflow`           |
| `workflowType`        | string  | No       | `strict` (default) or `flexible`              |
| `description`         | string  | No       | Description                                   |
| `applicableItemTypes` | array   | No       | Item types this workflow applies to           |
| `states`              | array   | No       | Array of state definitions                    |
| `transitions`         | array   | No       | Array of transition definitions               |
| `isActive`            | boolean | No       | Whether the workflow is active (default true) |

### State Definition

| Field       | Type    | Required | Description                 |
| ----------- | ------- | -------- | --------------------------- |
| `id`        | string  | Yes      | Unique state identifier     |
| `name`      | string  | Yes      | Display name                |
| `isInitial` | boolean | No       | True for the starting state |
| `isFinal`   | boolean | No       | True for terminal states    |
| `color`     | string  | No       | Display color               |

### Transition Definition

| Field              | Type   | Required | Description                    |
| ------------------ | ------ | -------- | ------------------------------ |
| `id`               | string | No       | Unique transition identifier   |
| `name`             | string | Yes      | Display name                   |
| `fromStateId`      | string | Yes      | Source state ID                |
| `toStateId`        | string | Yes      | Target state ID                |
| `guards`           | array  | No       | Guard conditions               |
| `lifecycleEffects` | array  | No       | Side effects on affected items |

### Example

```bash
curl -X POST /api/workflows \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ECO Approval Workflow",
    "definitionType": "workflow",
    "workflowType": "strict",
    "description": "Standard ECO approval process",
    "applicableItemTypes": ["ChangeOrder"],
    "states": [
      { "id": "in-work", "name": "In Work", "isInitial": true },
      { "id": "in-review", "name": "In Review" },
      { "id": "approved", "name": "Approved", "isFinal": true },
      { "id": "rejected", "name": "Rejected", "isFinal": true }
    ],
    "transitions": [
      {
        "name": "Submit for Review",
        "fromStateId": "in-work",
        "toStateId": "in-review"
      },
      {
        "name": "Approve",
        "fromStateId": "in-review",
        "toStateId": "approved"
      },
      {
        "name": "Reject",
        "fromStateId": "in-review",
        "toStateId": "rejected"
      },
      {
        "name": "Rework",
        "fromStateId": "rejected",
        "toStateId": "in-work"
      }
    ]
  }'
```

**Status:** `201 Created`

## Get Workflow Definition

```
GET /api/workflows/:id
```

Returns a single workflow definition by ID. Auth required.

### Response

```json
{
  "data": {
    "workflow": {
      "id": "def-uuid",
      "name": "Standard Part Lifecycle",
      "definitionType": "lifecycle",
      "workflowType": "strict",
      "description": "...",
      "applicableItemTypes": ["Part", "Document"],
      "states": [...],
      "transitions": [...],
      "isActive": true,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-01-10T12:00:00.000Z"
    }
  }
}
```

## Update Workflow Definition

```
PUT /api/workflows/:id
```

Updates a workflow definition. Auth required.

### Request Body

All fields are optional:

```json
{
  "name": "Updated Lifecycle",
  "description": "Updated description",
  "applicableItemTypes": ["Part", "Document", "Requirement"],
  "states": [...],
  "transitions": [...],
  "isActive": true
}
```

## Delete Workflow Definition

```
DELETE /api/workflows/:id
```

Deletes a workflow definition. Auth required.

### Response

```json
{
  "data": {
    "success": true
  }
}
```

## Approvers

### Get All Approvers

```
GET /api/workflows/:id/approvers
```

Returns approvers configured for all states in a workflow definition. Auth required.

### Response

```json
{
  "data": {
    "approvers": [
      {
        "stateId": "in-review",
        "stateName": "In Review",
        "approvers": [
          {
            "id": "approver-uuid",
            "userId": "user-uuid",
            "roleId": "role-uuid",
            "userName": "Jane Smith",
            "roleName": "Engineering Lead"
          }
        ]
      }
    ]
  }
}
```

### Get State Approvers

```
GET /api/workflows/:id/states/:stateId/approvers
```

Returns approvers for a specific workflow state.

### Add Approver

```
POST /api/workflows/:id/states/:stateId/approvers
```

Adds an approver (user or role) to a workflow state.

### Request Body

```json
{
  "userId": "user-uuid",
  "roleId": "role-uuid"
}
```

Provide either `userId` (user-based approval) or `roleId` (role-based approval) or both.

### Remove Approver

```
DELETE /api/workflows/:id/states/:stateId/approvers/:approverId
```

Removes an approver from a workflow state.

## Workflow Types

### Strict Workflows

Strict workflows enforce that transitions can only follow the defined state machine. All states and transitions are fixed at definition time.

### Flexible Workflows

Flexible workflows allow per-instance customization of states and transitions. When a workflow instance is started from a flexible definition, the instance gets its own copy of states and transitions that can be modified.

Use `PUT /api/change-orders/:id/workflow/structure` to modify the structure of a flexible workflow instance.

## Workflow Guards

Transitions can have guard conditions that must be met before the transition is allowed:

| Guard Type           | Description                                |
| -------------------- | ------------------------------------------ |
| `requires_approval`  | Requires approval votes before transition  |
| `role_required`      | Only users with specific roles can execute |
| `all_items_reviewed` | All affected items must be reviewed        |

Guards are evaluated by `GET /api/change-orders/:id/workflow/transition` and returned in the `allowed` field.

## Lifecycle Effects

Transitions can have lifecycle effects that automatically transition affected items when the ECO transitions:

```json
{
  "name": "Release",
  "fromStateId": "approved",
  "toStateId": "released",
  "lifecycleEffects": [
    {
      "changeAction": "modify",
      "lifecycleDefinitionId": "part-lifecycle-uuid",
      "fromStateId": "In Review",
      "toStateId": "Released"
    }
  ]
}
```

When the ECO transitions to "Released", all affected items with `changeAction: "modify"` that are in "In Review" state will automatically transition to "Released".

## Workflow Instance Endpoints

Workflow instances are managed through the change order API. See the [Change Orders API](./change-orders.md) for:

- `GET /api/change-orders/:id/workflow` -- get instance
- `POST /api/change-orders/:id/workflow` -- start instance
- `GET /api/change-orders/:id/workflow/transition` -- available transitions
- `POST /api/change-orders/:id/workflow/transition` -- execute transition
- `GET /api/change-orders/:id/workflow/history` -- transition history
- `GET /api/change-orders/:id/approvals` -- approval status
- `POST /api/change-orders/:id/approvals` -- submit vote
