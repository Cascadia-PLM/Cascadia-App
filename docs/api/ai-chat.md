# AI Chat API

AI-powered chatbot that can search PLM data, answer questions, create items, and initiate collaborative design sessions. Uses TanStack AI with configurable providers (OpenAI, Anthropic, Gemini, Ollama) and streams responses via Server-Sent Events.

## Overview

| Endpoint                        | Method | Auth                | Description                           |
| ------------------------------- | ------ | ------------------- | ------------------------------------- |
| `/api/ai/chat`                  | POST   | Auth required       | Send a message and stream AI response |
| `/api/ai/sessions`              | GET    | Auth required       | List user's chat sessions             |
| `/api/ai/sessions`              | POST   | Auth required       | Create a new chat session             |
| `/api/ai/sessions/:id`          | GET    | Auth required       | Get session details                   |
| `/api/ai/sessions/:id`          | DELETE | Auth required       | Delete a session                      |
| `/api/ai/sessions/:id/messages` | GET    | Auth required       | Get message history                   |
| `/api/ai/settings`              | GET    | Auth required       | Get AI provider settings              |
| `/api/ai/settings`              | POST   | Permission required | Create AI settings                    |
| `/api/ai/settings`              | PUT    | Permission required | Update AI settings                    |

---

## POST /api/ai/chat

Send a user message and receive a streaming AI response. This is the primary chat endpoint. It handles session management, message persistence, context building, and tool execution automatically.

### Request Body

Uses the TanStack AI client format:

```json
{
  "messages": [
    { "role": "user", "content": "Show me all parts in Draft state" }
  ],
  "data": {
    "sessionId": "session-uuid",
    "programId": "program-uuid",
    "designId": "design-uuid",
    "mode": "chat"
  }
}
```

| Field                | Type   | Required | Description                                                        |
| -------------------- | ------ | -------- | ------------------------------------------------------------------ |
| `messages`           | Array  | Yes      | Message array. Only the last `user` message is processed.          |
| `messages[].role`    | string | Yes      | `system`, `user`, or `assistant`                                   |
| `messages[].content` | string | Yes      | Message text                                                       |
| `data.sessionId`     | UUID   | No       | Existing session to continue. A new session is created if omitted. |
| `data.programId`     | UUID   | No       | Scope chat to a specific program                                   |
| `data.designId`      | UUID   | No       | Scope chat to a specific design                                    |
| `data.mode`          | string | No       | `chat` (default) for full tool set, `search` for search-only tools |

### Response

Returns a Server-Sent Events stream (via `toServerSentEventsResponse` from TanStack AI). The response includes custom headers:

| Header         | Description                                               |
| -------------- | --------------------------------------------------------- |
| `Content-Type` | `text/event-stream`                                       |
| `X-Request-Id` | Request trace ID                                          |
| `X-Session-Id` | Session UUID (useful when a new session was auto-created) |

The stream contains TanStack AI chunks including:

- `content` -- Accumulated text content from the LLM
- `tool_call` -- Tool invocation by the LLM
- `tool_result` -- Result from tool execution

### Modes

| Mode     | Tool set                                                                                        | Description                                     |
| -------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `chat`   | Full (read + write + design engine)                                                             | General-purpose assistant with all capabilities |
| `search` | Search-only (search_items, get_item_details, offer_navigation, search_programs, search_designs) | Lightweight mode for quickly finding items      |

### Session auto-creation

If no `sessionId` is provided, a new session is created automatically. The session ID is returned in the `X-Session-Id` response header.

### Message persistence

- The user message is saved to the session before streaming begins
- The assistant's full response is saved after the stream completes (or is aborted)
- Message history is loaded from the database and included in the LLM context

### Context building

The chat endpoint builds a system prompt that includes:

- PLM schema context (item types, fields, relationships) from `KnowledgeService`
- User identity and roles
- Program and design names (if scoped)
- Mode-specific instructions (chat vs search)

---

## Available AI tools

### Read tools

| Tool                    | Description                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `search_items`          | Search items by type, text query, state, or design. Returns id, itemNumber, name, revision, state. |
| `get_item_details`      | Get full item details by ID or item number. Includes type-specific fields.                         |
| `get_bom`               | Get Bill of Materials for a part. Supports multi-level depth (1-10).                               |
| `get_where_used`        | Reverse BOM query -- find all parent assemblies using an item.                                     |
| `analyze_change_impact` | Assess impact of changing an item: affected assemblies, documents, change orders, risk level.      |
| `offer_navigation`      | Present a clickable navigation button to the user for an item page.                                |
| `search_programs`       | Search programs by name, code, status, or customer.                                                |
| `search_designs`        | Search designs by name, code, type, or program.                                                    |

### Write tools

Write tools use a two-step confirmation flow:

1. Tool is called with `confirmed: false` (or omitted)
2. Returns `requiresConfirmation: true` with details
3. AI presents a confirmation card to the user
4. User clicks Confirm or Cancel
5. Tool is called again with `confirmed: true`
6. Operation executes

| Tool                    | Description                                    |
| ----------------------- | ---------------------------------------------- |
| `create_item`           | Create a Part, Document, Requirement, or Task  |
| `update_item`           | Update an existing item's properties           |
| `create_relationship`   | Create BOM or Document reference relationships |
| `transition_item_state` | Move items through workflow states             |
| `create_change_order`   | Create a new Engineering Change Order          |

### Design engine tool

| Tool                            | Description                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------- |
| `initiate_collaborative_design` | Start a collaborative design session from the chat. Returns a workspace URL. |

---

## GET /api/ai/sessions

List all chat sessions for the authenticated user.

### Response

```json
{
  "data": {
    "sessions": [
      {
        "id": "session-uuid",
        "title": "Widget Assembly BOM Analysis",
        "createdAt": "2025-03-15T10:00:00.000Z",
        "updatedAt": "2025-03-15T10:30:00.000Z"
      }
    ],
    "total": 5
  }
}
```

Session titles are auto-generated from the first user message.

---

## POST /api/ai/sessions

Create a new chat session explicitly (instead of relying on auto-creation via `/api/ai/chat`).

### Request Body

```json
{
  "programId": "program-uuid",
  "designId": "design-uuid"
}
```

| Field       | Type | Required | Description                      |
| ----------- | ---- | -------- | -------------------------------- |
| `programId` | UUID | No       | Associate session with a program |
| `designId`  | UUID | No       | Associate session with a design  |

### Response (201 Created)

```json
{
  "data": {
    "session": {
      "id": "session-uuid",
      "userId": "user-uuid",
      "programId": "program-uuid",
      "designId": "design-uuid",
      "title": null,
      "createdAt": "2025-03-15T10:00:00.000Z",
      "updatedAt": "2025-03-15T10:00:00.000Z"
    }
  }
}
```

---

## GET /api/ai/sessions/:id

Get session details with related program and design data.

### Response

```json
{
  "data": {
    "session": {
      "id": "session-uuid",
      "userId": "user-uuid",
      "programId": "program-uuid",
      "designId": "design-uuid",
      "title": "Widget Assembly BOM Analysis",
      "createdAt": "2025-03-15T10:00:00.000Z",
      "updatedAt": "2025-03-15T10:30:00.000Z",
      "program": {
        "id": "program-uuid",
        "name": "Widget Assembly",
        "code": "WIDGET"
      },
      "design": {
        "id": "design-uuid",
        "name": "Widget Prototype",
        "code": "WA-PROTO"
      }
    }
  }
}
```

### Errors

| Status | Condition                                            |
| ------ | ---------------------------------------------------- |
| 404    | Session not found or not owned by authenticated user |

---

## DELETE /api/ai/sessions/:id

Delete a chat session and its message history.

### Response

**204 No Content** on success.

---

## GET /api/ai/sessions/:id/messages

Get the full message history for a session.

### Response

```json
{
  "data": {
    "messages": [
      {
        "id": "msg-uuid",
        "sessionId": "session-uuid",
        "role": "user",
        "content": "Show me all parts in Draft state",
        "toolCalls": null,
        "toolCallId": null,
        "toolName": null,
        "createdAt": "2025-03-15T10:00:00.000Z"
      },
      {
        "id": "msg-uuid-2",
        "sessionId": "session-uuid",
        "role": "assistant",
        "content": "I found 12 parts in Draft state...",
        "toolCalls": null,
        "toolCallId": null,
        "toolName": null,
        "createdAt": "2025-03-15T10:00:05.000Z"
      }
    ],
    "total": 2
  }
}
```

---

## AI Settings

### GET /api/ai/settings

Get the current AI provider configuration. API keys are masked in the response.

#### Query Parameters

| Parameter   | Type | Default  | Description                                                         |
| ----------- | ---- | -------- | ------------------------------------------------------------------- |
| `programId` | UUID | _(none)_ | Get program-specific settings. If omitted, returns global settings. |

#### Response

```json
{
  "data": {
    "settings": {
      "id": "settings-uuid",
      "programId": null,
      "provider": "anthropic",
      "config": {
        "apiKey": "***",
        "model": "claude-sonnet-4-20250514"
      },
      "enabled": true,
      "createdAt": "2025-01-01T00:00:00.000Z",
      "updatedAt": "2025-03-15T10:00:00.000Z"
    },
    "availableProviders": ["openai", "anthropic"],
    "hasEnvConfig": true
  }
}
```

The `hasEnvConfig` field indicates whether `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` environment variables are set, which serve as fallback configuration.

### POST /api/ai/settings

Create AI settings. Requires `ai_settings:create` permission.

#### Request Body

```json
{
  "programId": "program-uuid",
  "provider": "anthropic",
  "config": {
    "apiKey": "sk-ant-...",
    "model": "claude-sonnet-4-20250514"
  },
  "enabled": true
}
```

| Field       | Type    | Required | Description                                                 |
| ----------- | ------- | -------- | ----------------------------------------------------------- |
| `programId` | UUID    | No       | Program to scope settings to. Omit for global settings.     |
| `provider`  | string  | Yes      | `openai`, `anthropic`, `gemini`, or `ollama`                |
| `config`    | object  | Yes      | Provider-specific configuration including API key and model |
| `enabled`   | boolean | No       | Enable/disable AI (default: true)                           |

### PUT /api/ai/settings

Update existing AI settings. Requires `ai_settings:update` permission.

Same request body as POST. All fields except `programId` (used for lookup) are optional for partial updates.

### Errors

| Status | Condition                                                                                  |
| ------ | ------------------------------------------------------------------------------------------ |
| 409    | Settings already exist for this scope (POST)                                               |
| 404    | Settings not found for this scope (PUT)                                                    |
| 422    | Invalid provider name                                                                      |
| 503    | AI is not enabled (returned by `/api/ai/chat` when no settings or API keys are configured) |
