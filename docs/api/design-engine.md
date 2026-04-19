# Design Engine Sessions API

The collaborative design engine is a multi-stage AI workflow that takes a product description through requirements drafting, BOM structuring, CAD generation, and assembly composition -- with human review at each stage. Sessions are persisted in the database and stage execution is streamed via Server-Sent Events.

## Overview

| Endpoint                                      | Method | Auth          | Description                           |
| --------------------------------------------- | ------ | ------------- | ------------------------------------- |
| `/api/design-engine/sessions`                 | GET    | Auth required | List user's sessions                  |
| `/api/design-engine/sessions`                 | POST   | Auth required | Create a new session                  |
| `/api/design-engine/sessions/:id`             | GET    | Auth required | Get session details                   |
| `/api/design-engine/sessions/:id`             | PATCH  | Auth required | Update session fields                 |
| `/api/design-engine/sessions/:id/stream`      | POST   | Auth required | Execute stage actions (SSE streaming) |
| `/api/design-engine/sessions/:id/materialize` | GET    | Auth required | Preview materialization               |
| `/api/design-engine/sessions/:id/materialize` | POST   | Auth required | Execute materialization               |

All endpoints require authentication. Sessions are scoped to the creating user -- only the session owner can access or modify their sessions.

## Session lifecycle

```
idle -> requirements_drafting -> requirements_review
     -> bom_drafting -> bom_review
     -> materialization
     -> cad_generation -> cad_review
     -> assembly_composition -> assembly_review
     -> complete
```

Stages alternate between AI drafting (streamed) and human review (non-streaming confirmation). The `error` and `paused` states can occur at any point.

### Session statuses

| Status      | Description                              |
| ----------- | ---------------------------------------- |
| `active`    | Session is in progress                   |
| `paused`    | Session paused by user or system         |
| `completed` | Materialization executed successfully    |
| `failed`    | An error occurred during stage execution |

---

## POST /api/design-engine/sessions

Create a new collaborative design session.

### Request Body

```json
{
  "description": "Design an electric go-kart for children ages 8-12",
  "programId": "uuid",
  "designId": "uuid",
  "aiChatSessionId": "uuid"
}
```

| Field             | Type   | Required | Description                                   |
| ----------------- | ------ | -------- | --------------------------------------------- |
| `description`     | string | Yes      | Product description / design brief            |
| `programId`       | UUID   | Yes      | Program to associate the session with         |
| `designId`        | UUID   | No       | Existing design to target for materialization |
| `aiChatSessionId` | UUID   | No       | Link to an existing AI chat session           |

### Response (201 Created)

```json
{
  "data": {
    "session": {
      "id": "session-uuid",
      "title": "Electric Go-Kart",
      "stage": "idle",
      "status": "active",
      "workspaceUrl": "/designs/collaborative/session-uuid"
    }
  }
}
```

---

## GET /api/design-engine/sessions

List all sessions for the authenticated user.

### Response

```json
{
  "data": {
    "sessions": [
      {
        "id": "session-uuid",
        "title": "Electric Go-Kart",
        "stage": "bom_review",
        "status": "active",
        "createdAt": "2025-03-15T10:00:00.000Z",
        "updatedAt": "2025-03-15T11:30:00.000Z"
      }
    ]
  }
}
```

---

## GET /api/design-engine/sessions/:id

Get full session details including artifacts.

### Response

```json
{
  "data": {
    "session": {
      "id": "session-uuid",
      "userId": "user-uuid",
      "title": "Electric Go-Kart",
      "stage": "bom_review",
      "status": "active",
      "programId": "program-uuid",
      "designId": "design-uuid",
      "artifacts": {
        "description": "Design an electric go-kart...",
        "requirements": [
          {
            "tempId": "req-1",
            "name": "Maximum speed",
            "description": "Top speed shall not exceed 15 km/h",
            "requirementType": "Performance",
            "priority": "high",
            "verificationMethod": "Test",
            "rationale": "Safety standard for children's vehicles",
            "confidence": 0.9,
            "source": "ai"
          }
        ],
        "bom": {
          "rootAssembly": {
            "tempId": "asm-1",
            "name": "Go-Kart Assembly",
            "isNew": true,
            "quantity": 1,
            "children": [],
            "requirementTempIds": [],
            "partType": "Manufacture",
            "rationale": "Top-level assembly",
            "confidence": 1.0
          },
          "proposedParts": [],
          "requirementsCoverage": {},
          "uncoveredRequirements": [],
          "validationIssues": []
        },
        "clarifications": [],
        "userMessages": []
      }
    }
  }
}
```

---

## PATCH /api/design-engine/sessions/:id

Update session fields. Supports updating the description, artifacts, or stage independently.

### Request Body

All fields are optional. Include only the fields you want to update.

```json
{
  "description": "Updated product description",
  "artifacts": {},
  "stage": "bom_drafting"
}
```

| Field         | Type   | Description                                                  |
| ------------- | ------ | ------------------------------------------------------------ |
| `description` | string | Updates the description inside the session's artifacts       |
| `artifacts`   | object | Replaces the session's artifact JSONB (merged with existing) |
| `stage`       | string | Moves the session to a different stage                       |

### Response

```json
{
  "data": {
    "session": {}
  }
}
```

---

## POST /api/design-engine/sessions/:id/stream

The primary endpoint for driving stage execution. Accepts an action and returns either a JSON response (for confirmations) or an SSE stream (for AI-driven stages).

### Request Body

```json
{
  "action": "start_requirements",
  "questionId": "clarification-id",
  "answer": "User's answer to clarification",
  "message": "Free-form user message",
  "tempId": "part-temp-id",
  "feedback": "Regeneration feedback"
}
```

| Field        | Type   | Required    | Description                             |
| ------------ | ------ | ----------- | --------------------------------------- |
| `action`     | string | Yes         | The action to perform (see table below) |
| `questionId` | string | Conditional | Required for `answer_clarification`     |
| `answer`     | string | Conditional | Required for `answer_clarification`     |
| `message`    | string | Conditional | Required for `send_message`             |
| `tempId`     | string | Conditional | Required for `regenerate_part`          |
| `feedback`   | string | No          | Optional feedback for `regenerate_part` |

### Actions

#### Streaming actions (return SSE response)

| Action                       | Description                                            |
| ---------------------------- | ------------------------------------------------------ |
| `start_requirements`         | Begin or restart requirements drafting stage           |
| `start_bom`                  | Begin or restart BOM drafting stage                    |
| `start_cad_generation`       | Begin CAD generation for BOM parts                     |
| `start_assembly_composition` | Begin assembly composition stage                       |
| `resume`                     | Resume the current in-progress drafting stage          |
| `regenerate_part`            | Regenerate CAD for a specific part (requires `tempId`) |

#### Non-streaming actions (return JSON)

| Action                 | Response                                 | Description                                   |
| ---------------------- | ---------------------------------------- | --------------------------------------------- |
| `confirm_requirements` | `{ session, confirmed: "requirements" }` | Confirm requirements and advance to BOM stage |
| `confirm_bom`          | `{ session, confirmed: "bom" }`          | Confirm BOM and advance to materialization    |
| `confirm_cad`          | `{ session, confirmed: "cad" }`          | Confirm CAD output                            |
| `confirm_assembly`     | `{ session, confirmed: "assembly" }`     | Confirm assembly composition                  |

#### Interactive actions (may return SSE or JSON)

| Action                 | Description                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `answer_clarification` | Answer a pending clarification question, then restart the current drafting stage as SSE                                     |
| `send_message`         | Send a free-form message; restarts drafting stage as SSE if in a drafting stage, otherwise returns `{ acknowledged: true }` |

### SSE event format

Streaming responses use `text/event-stream` content type with the following event structure:

```
event: stage_event
data: {"type":"llm_text","text":"Based on the requirements..."}

event: stage_event
data: {"type":"artifact_update","artifacts":{"requirements":[...]}}

event: stage_event
data: {"type":"stage_change","stage":"requirements_review"}

event: done
data: {"finished":true}
```

### StageEvent types

| Event type             | Fields                               | Description                                   |
| ---------------------- | ------------------------------------ | --------------------------------------------- |
| `stage_change`         | `stage`                              | Session moved to a new stage                  |
| `artifact_update`      | `artifacts` (partial)                | Updated artifacts to merge into session state |
| `llm_text`             | `text`                               | Streamed text from the LLM                    |
| `tool_call`            | `toolName`, `args`                   | LLM invoked a tool                            |
| `tool_result`          | `toolName`, `result`                 | Tool returned a result                        |
| `clarification_needed` | `questionId`, `question`, `options?` | AI needs user input before continuing         |
| `stage_complete`       | `stage`, `summary`                   | Stage finished successfully                   |
| `error`                | `message`                            | An error occurred                             |
| `paused`               | `reason`                             | Session was paused                            |
| `user_message`         | `id`, `text`                         | Echo of a user message                        |

### Response headers

| Header          | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `Content-Type`  | `text/event-stream` for streaming, `application/json` for non-streaming |
| `Cache-Control` | `no-cache`                                                              |
| `Connection`    | `keep-alive`                                                            |
| `X-Session-Id`  | Session UUID                                                            |

---

## GET /api/design-engine/sessions/:id/materialize

Preview what items would be created if materialization were executed. Requires a BOM to be present in the session artifacts.

### Response

```json
{
  "data": {
    "preview": {
      "newPartsCount": 8,
      "reusedPartsCount": 2,
      "newRequirementsCount": 5,
      "bomRelationshipsCount": 10,
      "requiresEco": true,
      "targetDesignId": "design-uuid",
      "items": [
        {
          "tempId": "part-1",
          "name": "Motor Mount",
          "itemType": "Part",
          "isNew": true
        },
        {
          "tempId": "part-2",
          "name": "Standard Bearing",
          "itemType": "Part",
          "isNew": false,
          "existingItemNumber": "P-1042"
        }
      ]
    }
  }
}
```

---

## POST /api/design-engine/sessions/:id/materialize

Execute materialization -- creates actual PLM items (parts, requirements, BOM relationships) from the session's draft artifacts. Creates an ECO if the target design is post-release.

Can only be executed once per session. After successful materialization the session status changes to `completed`.

### Response

```json
{
  "data": {
    "result": {
      "designId": "design-uuid",
      "ecoId": "eco-uuid",
      "ecoNumber": "ECO-0042",
      "createdItems": [
        {
          "tempId": "part-1",
          "itemId": "item-uuid",
          "itemNumber": "P-1050",
          "itemType": "Part",
          "name": "Motor Mount"
        }
      ],
      "bomRelationshipsCreated": 10
    }
  }
}
```

### Errors

| Status | Condition                                                     |
| ------ | ------------------------------------------------------------- |
| 404    | Session not found                                             |
| 403    | User is not the session owner                                 |
| 422    | No BOM artifacts to materialize, or session already completed |

---

## Session artifacts schema

The `artifacts` JSONB column stores the full design state:

```typescript
interface DesignArtifacts {
  description: string
  requirements: RequirementDraft[]
  bom: BomDraft | null
  clarifications: ClarificationEntry[]
  userMessages: UserMessage[]
  pendingClarificationId?: string
  materializationResult?: MaterializationResult
  cadGenerationState?: CadGenerationState
}
```

### RequirementDraft

| Field                | Type   | Description                                                     |
| -------------------- | ------ | --------------------------------------------------------------- |
| `tempId`             | string | Temporary ID (not a database UUID)                              |
| `name`               | string | Short requirement name                                          |
| `description`        | string | Full requirement text                                           |
| `requirementType`    | enum   | `Functional`, `Performance`, `Interface`, `Constraint`, `Other` |
| `priority`           | enum   | `low`, `medium`, `high`, `critical`                             |
| `verificationMethod` | enum   | `Analysis`, `Inspection`, `Test`, `Demonstration`               |
| `rationale`          | string | Why this requirement exists                                     |
| `confidence`         | number | AI confidence score (0-1)                                       |
| `source`             | enum   | `ai` or `user`                                                  |

### BomNodeDraft

| Field                 | Type           | Description                                      |
| --------------------- | -------------- | ------------------------------------------------ |
| `tempId`              | string         | Temporary ID                                     |
| `name`                | string         | Part name                                        |
| `isNew`               | boolean        | Whether this is a new part or an existing one    |
| `existingItemId`      | string         | If reusing an existing part, its item ID         |
| `quantity`            | number         | Quantity in parent assembly                      |
| `children`            | BomNodeDraft[] | Child nodes in the BOM tree                      |
| `requirementTempIds`  | string[]       | Linked requirement temp IDs                      |
| `partType`            | enum           | `Manufacture`, `Purchase`, `Software`, `Phantom` |
| `material`            | string         | Material specification                           |
| `rationale`           | string         | Design rationale                                 |
| `confidence`          | number         | AI confidence score (0-1)                        |
| `cadGeneration`       | object         | CAD generation status and output references      |
| `assemblyComposition` | object         | Assembly composition status                      |
