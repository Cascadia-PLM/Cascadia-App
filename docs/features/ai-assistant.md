# AI Assistant

## Overview

Cascadia includes an LLM-powered AI chatbot that helps users navigate, query, and modify PLM data through natural language. The assistant understands the PLM schema, respects user permissions, and can perform both read-only queries and write operations on the user's behalf.

The AI assistant is built on [TanStack AI](https://tanstack.com/ai), providing provider-agnostic LLM integration with streaming responses, type-safe tool definitions, and seamless integration with the Hono API server.

**Key capabilities:**

- Search for parts, documents, change orders, requirements, and tasks
- Inspect item details, BOMs, and where-used relationships
- Analyze change impact with risk assessment
- Create and update items, manage relationships, transition workflow states
- Create Engineering Change Orders (ECOs) with automatic branch setup
- Launch collaborative design sessions from the chat
- Navigate users to item pages with clickable buttons

All actions are permission-bounded and audit-logged.

---

## Chat Panel UI

The AI assistant appears as a slide-out panel on the right side of the screen.

### Opening the Panel

A tab-shaped button sits on the right edge of the viewport, vertically centered. Clicking it slides the chat panel into view. The button disappears while the panel is open.

- **Component**: `ChatPanelButton` (`src/components/ai/ChatPanelButton.tsx`)
- **State management**: `ChatPanelProvider` context (`src/lib/ai/chat-context.tsx`)
- **Keyboard shortcut**: None by default (toggle via the button)

### Panel Layout

The panel has four sections:

1. **Header** -- Title ("Cascadia Chat"), loading indicator, and action buttons (History, New Conversation, Close)
2. **Messages area** -- Scrollable message list with auto-scroll on new content
3. **Error display** -- Inline error banner when requests fail
4. **Input area** -- Auto-resizing textarea with Send and Search buttons

### Resizing

The panel is resizable by dragging the left edge. Width is persisted to `localStorage` and restored on next visit.

| Property      | Value |
| ------------- | ----- |
| Default width | 400px |
| Minimum width | 300px |
| Maximum width | 700px |

### Message Rendering

- **User messages**: Displayed as plain text in a cyan bubble, right-aligned
- **Assistant messages**: Rendered as Markdown using `react-markdown` with `remark-gfm`, left-aligned in a slate bubble. Supports headings, lists, tables, code blocks, links, and blockquotes.
- **Tool calls**: Shown as small monospace labels below the message text (e.g., `search_items`, `get_bom`). A "Running..." indicator appears while the tool is executing.
- **Navigation offers**: Rendered as clickable buttons below the message (e.g., "View P-1001"). Internal links navigate within the app; external links open in a new tab.
- **Design workspace offers**: Rendered as a "Open Design Workspace" button that navigates to the collaborative design workspace.
- **System messages**: Hidden from the UI.
- **Streaming**: A pulsing cursor animation appears at the end of the assistant's message while content is still streaming.

### Two Input Modes

The `ChatInput` component provides two ways to send messages:

| Mode       | Trigger                     | Behavior                                                                          |
| ---------- | --------------------------- | --------------------------------------------------------------------------------- |
| **Chat**   | Enter key or Send button    | Full conversational mode with all tools (read + write)                            |
| **Search** | Ctrl+Enter or Search button | Lightweight search mode -- uses a concise prompt and only search/navigation tools |

---

## Session Persistence

Chat conversations are saved to the database so users can resume them later.

### Database Schema

Three tables support AI chat persistence (defined in `src/lib/db/schema/ai.ts`):

**`ai_chat_sessions`** -- One row per conversation.

| Column       | Type         | Description                            |
| ------------ | ------------ | -------------------------------------- |
| `id`         | UUID         | Primary key                            |
| `user_id`    | UUID         | Session owner (FK to `users`)          |
| `program_id` | UUID         | Optional program context               |
| `design_id`  | UUID         | Optional design context                |
| `title`      | VARCHAR(255) | Auto-generated from first user message |
| `created_at` | TIMESTAMP    | When the session started               |
| `updated_at` | TIMESTAMP    | Last message timestamp                 |

**`ai_chat_messages`** -- Message history within a session.

| Column         | Type         | Description                              |
| -------------- | ------------ | ---------------------------------------- |
| `id`           | UUID         | Primary key                              |
| `session_id`   | UUID         | Parent session (FK, CASCADE delete)      |
| `role`         | VARCHAR(20)  | `system`, `user`, `assistant`, or `tool` |
| `content`      | TEXT         | Message content                          |
| `tool_calls`   | JSONB        | Tool calls made by the assistant         |
| `tool_call_id` | VARCHAR(100) | Tool response reference                  |
| `tool_name`    | VARCHAR(100) | Which tool was called                    |
| `created_at`   | TIMESTAMP    | Message timestamp                        |

### Session Lifecycle

1. **Auto-creation**: A session is created on the first message if none exists. The UI calls `POST /api/ai/sessions` before sending the first message.
2. **Title generation**: The `SessionService` auto-generates a title from the first user message. It extracts the first sentence (up to 50 characters) or truncates at a word boundary.
3. **Message persistence**: Each user message is saved before sending to the LLM. The assistant's response is saved after the stream completes.
4. **History loading**: When switching sessions, the UI fetches message history via `GET /api/ai/sessions/:id/messages` and reconstructs the message list.
5. **Ownership**: Sessions are scoped to the creating user. The `verifySessionOwnership` check prevents accessing other users' sessions.
6. **Cleanup**: `SessionService.cleanupOldSessions()` retains the 50 most recent sessions per user. Messages cascade-delete with their session.

### Session History UI

Clicking the History button in the panel header opens a full-panel overlay listing all past conversations, sorted by most recently updated. Each entry shows the title and date. Users can select a session to resume it or delete sessions they no longer need.

---

## Read-Only PLM Tools

Read tools let the AI query PLM data without modifying anything. They are used freely -- no confirmation is required.

### search_items

Search for items by type, text query, lifecycle state, or design.

| Parameter  | Type   | Description                                                         |
| ---------- | ------ | ------------------------------------------------------------------- |
| `itemType` | enum   | `Part`, `Document`, `ChangeOrder`, `Requirement`, `Task` (optional) |
| `query`    | string | Text search across item number and name                             |
| `state`    | string | Filter by lifecycle state (e.g., `Draft`, `Released`)               |
| `designId` | string | Design ID or code to scope the search                               |
| `limit`    | number | Max results (1-50, default 20)                                      |

Returns an array of matching items with `id`, `itemNumber`, `name`, `revision`, `state`, `itemType`, and `designId`.

### get_item_details

Get complete details for a specific item by ID or item number.

| Parameter    | Type   | Description                                     |
| ------------ | ------ | ----------------------------------------------- |
| `id`         | string | Item UUID                                       |
| `itemNumber` | string | Item number (e.g., `P-1001`)                    |
| `revision`   | string | Revision letter (optional, defaults to current) |

Returns all item fields including type-specific data (e.g., `material`, `cost` for Parts).

### get_bom

Get the Bill of Materials for a part.

| Parameter | Type   | Description                          |
| --------- | ------ | ------------------------------------ |
| `itemId`  | string | Parent part UUID                     |
| `depth`   | number | Levels to traverse (1-10, default 1) |

Returns child components with `quantity`, `findNumber`, `referenceDesignator`, and nested children if `depth > 1`.

### get_where_used

Reverse BOM query -- find all parent assemblies that use an item.

| Parameter  | Type   | Description                      |
| ---------- | ------ | -------------------------------- |
| `itemId`   | string | Item UUID                        |
| `maxDepth` | number | Max levels up (1-15, default 15) |

Returns parent assemblies with depth information and cross-design references.

### analyze_change_impact

Analyze the impact of changing a specific item.

| Parameter               | Type    | Description                                                |
| ----------------------- | ------- | ---------------------------------------------------------- |
| `itemId`                | string  | Item UUID                                                  |
| `includeDocuments`      | boolean | Include related documents (default true)                   |
| `includeRelatedChanges` | boolean | Find other active ECOs affecting same items (default true) |

Returns affected assemblies, related documents, related change orders, and a risk assessment with severity levels (`low`, `medium`, `high`, `critical`).

### offer_navigation

Offer a clickable navigation button to the user. Used after answering questions to provide quick access to the item being discussed.

| Parameter    | Type   | Description                                                                           |
| ------------ | ------ | ------------------------------------------------------------------------------------- |
| `itemId`     | string | Entity UUID                                                                           |
| `itemNumber` | string | Display number (e.g., `P-1001`, `ECO-0001`)                                           |
| `itemType`   | enum   | `Part`, `Document`, `ChangeOrder`, `Requirement`, `Task`, `Design`, `Program`         |
| `tab`        | enum   | Optional tab to open (`details`, `relationships`, `history`, `bom`, `affected-items`) |
| `label`      | string | Custom button label (defaults to "View {itemNumber}")                                 |

### search_programs

Search programs by name, code, customer, or status. Results are scoped to programs the user has access to.

### search_designs

Search designs by name, code, type, or program. Accepts program ID or code for filtering. Excludes archived designs by default.

---

## Write Tools

Write tools modify PLM data. Every write operation goes through a confirmation flow before executing.

### create_item

Create a new Part, Document, Requirement, or Task.

| Parameter         | Type   | Description                                                                         |
| ----------------- | ------ | ----------------------------------------------------------------------------------- |
| `itemType`        | enum   | `Part`, `Document`, `Requirement`, `Task`                                           |
| `name`            | string | Item name                                                                           |
| `designId`        | string | Design ID or code (required for Part/Document/Requirement)                          |
| `changeOrderId`   | string | ECO for post-release designs                                                        |
| `partType`        | enum   | `Manufacture`, `Purchase`, `Software`, `Phantom` (Parts only)                       |
| `material`        | string | Material specification (Parts only)                                                 |
| `priority`        | enum   | `low`, `medium`, `high`, `critical` (Tasks only)                                    |
| `requirementType` | enum   | `Functional`, `Performance`, `Interface`, `Constraint`, `Other` (Requirements only) |

If the target design has released items and no `changeOrderId` is provided, the tool suggests creating an ECO first rather than failing silently.

### update_item

Update an existing item's properties (name, description, material, cost, weight, etc.). Released items on main branch require an ECO checkout first.

### create_relationship

Create BOM, Document, or Affects relationships between items. Validates relationship type compatibility (e.g., BOM requires Part-to-Part). Includes validation against circular references.

### transition_item_state

Transition items or ECOs through workflow states. For ECOs, uses `ChangeOrderService.transitionWorkflow()` which handles the full ECO lifecycle including branch merging on approval. For regular items, updates the state directly.

### create_change_order

Create a new Engineering Change Order. Supports ECO, ECN, Deviation, and MCO change types. On creation:

1. Creates the change order item in Draft state
2. Auto-starts the workflow
3. Adds specified designs (creating ECO branches)
4. Adds specified affected items with appropriate change actions (`revise` for Released items, `release` for Draft items)

### initiate_collaborative_design

Launch an interactive collaborative design workspace. Unlike other write tools, this does not require confirmation -- creating a design session is lightweight and non-destructive. Requires a `programId` (UUID or code). Returns a workspace URL that the UI renders as an "Open Design Workspace" button.

---

## Confirmation Flow

Write operations use a two-step confirmation flow to prevent unintended modifications.

### How It Works

```
User: "Create a new part called Motor Assembly"

  1. AI calls create_item with confirmed: false
  2. Tool returns { requiresConfirmation: true, confirmationMessage: "...", confirmationDetails: {...} }
  3. AI renders a ConfirmationCard in the chat

User clicks "Confirm"

  4. AI calls create_item again with confirmed: true
  5. Tool executes the operation
  6. AI reports the result (item number, success/failure)
```

### ConfirmationCard Component

The `ConfirmationCard` (`src/components/ai/ConfirmationCard.tsx`) displays:

- An alert icon color-coded by action type (cyan for create/update, amber for transition, red for delete)
- The confirmation message explaining what will happen
- Structured details: item type, item name, design name, ECO number, and additional info
- **Confirm** and **Cancel** buttons

After responding, the card collapses to a static badge showing "Confirmed" (green) or "Cancelled" (grey).

### ECO Suggestion Flow

When a write operation targets a released design without an ECO, the tool does not fail. Instead it returns a `suggestCreateEco` flag with a message like:

> "The design 'Widget Assembly Prototype' has released items and requires an ECO to add new items. Would you like me to create an ECO first?"

The AI then offers to create the ECO before retrying the original operation.

---

## Provider Support

The AI assistant supports multiple LLM providers through TanStack AI adapters.

### Supported Providers

| Provider               | Status    | Default Model       | Adapter                  |
| ---------------------- | --------- | ------------------- | ------------------------ |
| **Anthropic** (Claude) | Supported | `claude-sonnet-4-6` | `@tanstack/ai-anthropic` |
| **OpenAI** (GPT)       | Supported | `gpt-4.1`           | `@tanstack/ai-openai`    |
| **Google** (Gemini)    | Planned   | `gemini-2.0-flash`  | Not yet implemented      |
| **Ollama** (local)     | Planned   | `llama3.2`          | Not yet implemented      |

### Provider Selection

The `getAdapter()` function in `src/lib/ai/adapters.ts` creates the appropriate TanStack AI adapter based on the provider configuration. It accepts a provider type, model name, API key, and optional base URL.

OpenAI's adapter supports a custom `baseURL` parameter, which enables use with OpenAI-compatible APIs (Azure OpenAI, local proxies, etc.).

---

## Admin Configuration

AI settings can be configured at two levels: globally or per-program.

### Configuration Priority

When the chat endpoint processes a request, it resolves the provider configuration in this order:

1. **Program-specific settings** -- If the session has a `programId` and that program has AI settings in `ai_settings`, use them
2. **Global settings** -- If no program-specific settings exist, use the global row (where `programId` is NULL)
3. **Environment variables** -- Fall back to `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`

This allows different programs to use different providers or models.

### Environment Variables

| Variable            | Description                                    |
| ------------------- | ---------------------------------------------- |
| `OPENAI_API_KEY`    | OpenAI API key (fallback if no DB settings)    |
| `OPENAI_MODEL`      | Override default OpenAI model                  |
| `OPENAI_BASE_URL`   | Custom OpenAI-compatible endpoint              |
| `ANTHROPIC_API_KEY` | Anthropic API key (fallback if no DB settings) |
| `ANTHROPIC_MODEL`   | Override default Anthropic model               |

### Settings API

The settings API (`/api/ai/settings`) manages provider configuration stored in the `ai_settings` table.

| Endpoint                         | Method | Permission           | Description              |
| -------------------------------- | ------ | -------------------- | ------------------------ |
| `/api/ai/settings?programId=...` | GET    | Authenticated        | Get settings for a scope |
| `/api/ai/settings`               | POST   | `ai_settings:create` | Create settings          |
| `/api/ai/settings`               | PUT    | `ai_settings:update` | Update settings          |

**Security**: API keys stored in the database are encrypted at rest using the `@/lib/crypto/encryption` module. The GET endpoint masks API keys in responses (returns `***` instead of the actual key). Keys with known provider prefixes (`sk-`, `key-`) are detected as plaintext and skipped during decryption.

### Enabling/Disabling AI

Each settings row has an `enabled` boolean flag. When disabled, the chat endpoint returns a 503 response with a `FEATURE_DISABLED` error code. The `isAIEnabled()` function checks settings in the same priority order as provider config resolution.

---

## Tool Definitions

Tools are defined using TanStack AI's `toolDefinition()` function with Zod schemas for both input and output validation. This provides type safety across the entire stack -- the LLM receives the schema, handlers validate against it, and TypeScript catches mismatches at compile time.

### Definition Structure

Each tool definition includes:

- **`name`** -- Unique identifier (e.g., `search_items`)
- **`description`** -- Natural language description the LLM uses to decide when to call the tool
- **`inputSchema`** -- Zod schema defining the parameters
- **`outputSchema`** -- Zod schema defining the return type

### Tool Registration

Tools are assembled in `src/lib/ai/tools/index.ts`:

- **`createServerTools(context)`** -- Returns all 14 tools (8 read + 5 write + 1 design engine) bound to a user context
- **`createSearchTools(context)`** -- Returns 5 lightweight tools (search_items, get_item_details, offer_navigation, search_programs, search_designs) for search mode

The `context` object carries `userId`, `sessionId`, `programId`, and `designId` through to every handler.

### Complete Tool Reference

| #   | Tool                            | Category | Permission             | Description                                   |
| --- | ------------------------------- | -------- | ---------------------- | --------------------------------------------- |
| 1   | `search_items`                  | Read     | `parts:read`           | Search items by type, query, state, design    |
| 2   | `get_item_details`              | Read     | `parts:read`           | Get full item details by ID or item number    |
| 3   | `get_bom`                       | Read     | `parts:read`           | Get BOM children for a part                   |
| 4   | `get_where_used`                | Read     | `parts:read`           | Find parent assemblies using an item          |
| 5   | `analyze_change_impact`         | Read     | `parts:read`           | Analyze change impact with risk assessment    |
| 6   | `offer_navigation`              | Read     | None                   | Generate navigation URL for UI button         |
| 7   | `search_programs`               | Read     | `programs:read`        | Search programs by name, code, customer       |
| 8   | `search_designs`                | Read     | `designs:read`         | Search designs by name, code, program         |
| 9   | `create_item`                   | Write    | `parts:create`         | Create Part, Document, Requirement, or Task   |
| 10  | `update_item`                   | Write    | `parts:update`         | Update item properties                        |
| 11  | `create_relationship`           | Write    | `parts:update`         | Create BOM, Document, or Affects relationship |
| 12  | `transition_item_state`         | Write    | `change_orders:update` | Transition workflow state                     |
| 13  | `create_change_order`           | Write    | `change_orders:create` | Create ECO with branches and affected items   |
| 14  | `initiate_collaborative_design` | Design   | `parts:create`         | Launch collaborative design workspace         |

---

## Architecture

### System Layers

```
Frontend (Browser)
  ChatPanel + useChat hook (@tanstack/ai-react)
  fetchServerSentEvents('/api/ai/chat')
       |
       | SSE Stream
       v
API Layer (Server)
  POST /api/ai/chat
    - Authenticates user
    - Loads/creates session
    - Loads provider config
    - Builds system prompt via KnowledgeService
    - Calls chat() with adapter + tools
    - Returns SSE stream via toServerSentEventsResponse()
       |
       v
Service Layer
  KnowledgeService  -- Schema introspection, system prompt generation
  SessionService    -- Session + message persistence
  Adapters          -- Provider-specific TanStack AI adapters
  Tool Handlers     -- Permission-checked tool implementations
       |
       v
Database
  ai_chat_sessions  -- Conversation persistence
  ai_chat_messages  -- Message history
  ai_settings       -- Provider configuration
  ai_usage_logs     -- Audit trail for tool usage
```

### Request Flow

1. The user types a message in the `ChatInput` component
2. `ChatPanel` creates a session if needed (`POST /api/ai/sessions`)
3. `useChat` from `@tanstack/ai-react` sends the message via `fetchServerSentEvents` to `POST /api/ai/chat`
4. The API handler:
   a. Verifies authentication and session ownership
   b. Checks if AI is enabled for the program scope
   c. Loads provider configuration (program-specific, global, or env vars)
   d. Calls `KnowledgeService.generateSchemaContext()` to reflect on the `ItemTypeRegistry` and build schema-aware context
   e. Builds a system prompt with user context, item type definitions, versioning model, and tool documentation
   f. Loads message history from the database
   g. Saves the user message
   h. Creates tools bound to the user's permission context via `createServerTools()`
   i. Calls `chat()` from `@tanstack/ai` with the adapter, messages, and tools
   j. Wraps the response stream in a `toServerSentEventsResponse()` with session ID header
5. The response streams back as Server-Sent Events (SSE)
6. `useChat` on the client processes chunks and updates the message list in real time
7. After the stream completes, the assistant's full response is saved to `ai_chat_messages`

### KnowledgeService

The `KnowledgeService` (`src/lib/ai/KnowledgeService.ts`) makes the AI schema-aware by:

1. **Reflecting on ItemTypeRegistry** -- Enumerates all registered item types (Part, Document, ChangeOrder, etc.) with their fields, states, relationships, and permissions
2. **Extracting field definitions** -- Converts Zod schemas to JSON Schema format, then extracts field names, types, descriptions, and required flags
3. **Building the system prompt** -- Produces a structured prompt that tells the AI about available item types, the ECO-as-Branch versioning model, the user's identity and roles, and detailed instructions for each tool
4. **Search mode prompt** -- A separate, concise prompt for search mode that instructs the AI to search immediately and return structured results

The system prompt includes the current program and design context, so the AI understands what scope the user is working in.

### Permission Enforcement

Every tool handler is wrapped with `withPermissionAndAudit()` (for read tools) or `withWritePermissionAndAudit()` (for write tools) from `src/lib/ai/tools/permission-wrapper.ts`. These wrappers:

1. **Check permissions** via `permissionService.canUser()` before executing the handler
2. **Throw on denial** with a descriptive error message the AI can relay to the user
3. **Log to audit table** -- Every tool invocation (success or failure) is recorded in `ai_usage_logs` with the tool name, parameters, result, error (if any), and duration

### Audit Trail

The `ai_usage_logs` table records every tool invocation:

| Column                           | Description                          |
| -------------------------------- | ------------------------------------ |
| `tool_name`                      | Which tool was called                |
| `tool_params`                    | Input parameters (JSONB)             |
| `tool_result`                    | Output result (JSONB, null on error) |
| `error`                          | Error message if the tool failed     |
| `duration_ms`                    | Execution time                       |
| `user_id`                        | Who triggered the action             |
| `session_id`                     | Which chat session                   |
| `input_tokens` / `output_tokens` | Token usage (when available)         |
| `provider` / `model`             | Which LLM was used                   |

For write operations, the `_meta` field within `tool_params` includes additional audit data: `actionType`, `affectedItemIds`, `wasConfirmed`, and a `transactionId`.

### Streaming

Responses use Server-Sent Events (SSE) for real-time streaming:

1. `chat()` from `@tanstack/ai` returns an async iterable of chunks
2. The API route wraps this in a `transformedStream` generator that accumulates the full response text
3. `toServerSentEventsResponse()` converts the iterable into an SSE `Response` with `text/event-stream` content type
4. On the client, `fetchServerSentEvents` (from `@tanstack/ai-react`) reconnects to the SSE endpoint and feeds chunks into `useChat`'s message state
5. The `onFinish` callback fires when the stream ends, triggering a session list refresh

The API sets `X-Session-Id` and `X-Request-Id` headers on the SSE response for traceability.

---

## API Reference

| Endpoint                        | Method | Auth                  | Description                             |
| ------------------------------- | ------ | --------------------- | --------------------------------------- |
| `/api/ai/chat`                  | POST   | Authenticated         | Send a chat message, receive SSE stream |
| `/api/ai/sessions`              | GET    | Authenticated         | List user's sessions                    |
| `/api/ai/sessions`              | POST   | Authenticated         | Create a new session                    |
| `/api/ai/sessions/:id`          | GET    | Authenticated (owner) | Get session details                     |
| `/api/ai/sessions/:id`          | DELETE | Authenticated (owner) | Delete session and messages             |
| `/api/ai/sessions/:id/messages` | GET    | Authenticated (owner) | Get message history                     |
| `/api/ai/settings`              | GET    | Authenticated         | Get AI settings                         |
| `/api/ai/settings`              | POST   | `ai_settings:create`  | Create AI settings                      |
| `/api/ai/settings`              | PUT    | `ai_settings:update`  | Update AI settings                      |

---

## Key Source Files

| File                                            | Purpose                                                      |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `src/lib/ai/adapters.ts`                        | Provider adapter factory and config loading                  |
| `src/lib/ai/SessionService.ts`                  | Session and message persistence                              |
| `src/lib/ai/KnowledgeService.ts`                | Schema introspection and system prompt generation            |
| `src/lib/ai/chat-context.tsx`                   | React context for panel state management                     |
| `src/lib/ai/tools/definitions.ts`               | Read-only tool definitions (Zod schemas)                     |
| `src/lib/ai/tools/write-definitions.ts`         | Write tool definitions with confirmation schemas             |
| `src/lib/ai/tools/handlers.ts`                  | Read-only tool handler implementations                       |
| `src/lib/ai/tools/write-handlers.ts`            | Write tool handler implementations                           |
| `src/lib/ai/tools/permission-wrapper.ts`        | Permission checking and audit logging wrapper                |
| `src/lib/ai/tools/design-engine-definitions.ts` | Collaborative design tool definition                         |
| `src/lib/ai/tools/design-engine-handlers.ts`    | Collaborative design tool handler                            |
| `src/lib/ai/tools/index.ts`                     | Tool assembly and exports                                    |
| `src/lib/db/schema/ai.ts`                       | Database schema for sessions, messages, settings, usage logs |
| `src/components/ai/ChatPanel.tsx`               | Main chat sidebar component                                  |
| `src/components/ai/ChatMessage.tsx`             | Message rendering with Markdown and tool results             |
| `src/components/ai/ChatInput.tsx`               | Input component with Send/Search modes                       |
| `src/components/ai/ChatPanelButton.tsx`         | Edge button to open the panel                                |
| `src/components/ai/ConfirmationCard.tsx`        | Confirmation UI for write operations                         |
| `src/routes/api/ai/chat.ts`                     | Chat API endpoint                                            |
| `src/routes/api/ai/sessions.ts`                 | Session list and creation endpoints                          |
| `src/routes/api/ai/sessions/$id.ts`             | Session detail and deletion endpoints                        |
| `src/routes/api/ai/sessions/$id/messages.ts`    | Message history endpoint                                     |
| `src/routes/api/ai/settings.ts`                 | AI settings CRUD endpoints                                   |
