# System Settings

This guide covers the administrative configuration options available in Cascadia PLM, including item type configuration, lifecycle and workflow management, AI settings, vault configuration, and the general settings system.

All admin endpoints require the `Administrator` role unless otherwise noted.

## Item Type Configuration

Cascadia uses a hybrid code-first + runtime configuration model. Item types (Part, Document, ChangeOrder, etc.) are defined in TypeScript with type-safe schemas, but their business rules can be overridden at runtime without redeployment.

### What Can Be Configured at Runtime

| Setting                 | Description                                                      |
| ----------------------- | ---------------------------------------------------------------- |
| `label`                 | Display name (e.g., rename "Part" to "Component")                |
| `pluralLabel`           | Plural display name                                              |
| `icon`                  | Lucide icon name                                                 |
| `lifecycleDefinitionId` | Link to a workflow definition for lifecycle states               |
| `permissions`           | CRUD permission arrays (role names that can perform each action) |
| `relationships`         | Allowed relationship types and targets                           |
| `fieldMetadata`         | Per-field labels, descriptions, required/visible flags           |
| `workflowsByChangeType` | (ChangeOrder only) Map change types to workflow definitions      |

### What Requires Code Changes

- Database schema (adding columns)
- Zod validation schemas
- React components
- Table mappings
- Default state definitions

### API Endpoints

#### List all item type configurations

```
GET /api/admin/item-type-configs
```

Returns every registered item type with its code definition, runtime override (if any), and the merged result.

**Response structure**:

```json
{
  "data": {
    "configs": [
      {
        "itemType": "Part",
        "hasCodeDefinition": true,
        "hasRuntimeConfig": true,
        "codeConfig": { "label": "Part", "permissions": { ... } },
        "runtimeConfig": { "id": "...", "version": 2, "config": { ... } },
        "mergedConfig": { "label": "Component", "permissions": { ... } }
      }
    ]
  }
}
```

#### Create or update a runtime override

```
POST /api/admin/item-type-configs
Content-Type: application/json

{
  "itemType": "Part",
  "config": {
    "label": "Component",
    "pluralLabel": "Components",
    "permissions": {
      "create": ["Engineer", "Administrator"],
      "read": ["*"],
      "update": ["Engineer", "Administrator"],
      "delete": ["Administrator"]
    }
  }
}
```

After saving, the `ItemTypeRegistry` is automatically reloaded so changes take effect immediately on the current instance.

Returns `201` for a new configuration or `200` for an update.

#### Delete a runtime override (revert to code defaults)

```
DELETE /api/admin/item-type-configs/:itemType
```

#### Reload all configurations

```
POST /api/admin/reload-config
```

Forces all instances to reload runtime configurations from the database. Use this after direct database changes or in multi-instance deployments.

### Configuration Merging

When the system resolves an item type configuration:

1. The code-defined configuration is loaded (always present)
2. The runtime configuration is loaded from the `item_type_configs` table (may not exist)
3. Runtime values override code defaults field by field (runtime wins)
4. The merged result is cached in memory

If no runtime override exists, the code defaults are used as-is.

### Database Table

Runtime configurations are stored in `item_type_configs`:

| Column        | Type        | Description                             |
| ------------- | ----------- | --------------------------------------- |
| `id`          | UUID        | Primary key                             |
| `item_type`   | VARCHAR(50) | Item type name (unique)                 |
| `config`      | JSONB       | Runtime configuration object            |
| `version`     | INTEGER     | Version number (for optimistic locking) |
| `is_active`   | BOOLEAN     | Soft delete flag                        |
| `modified_by` | UUID        | User who last modified                  |
| `modified_at` | TIMESTAMPTZ | Last modification time                  |
| `created_at`  | TIMESTAMPTZ | Creation time                           |

For complete documentation, see `docs/runtime-configuration.md`.

## Lifecycle Configuration

Lifecycles define the valid states and transitions for item types. Cascadia uses a unified lifecycle model with three types:

| Lifecycle Type | Description                                    | Example Item Types |
| -------------- | ---------------------------------------------- | ------------------ |
| **Free**       | Self-controlled with transitions               | Programs, Designs  |
| **Driven**     | Controlled by ECOs, declares valid states only | Parts, Documents   |
| **Driving**    | Controls Driven lifecycles, has merge actions  | Change Orders      |

### Workflow Definitions Table

Lifecycle definitions are stored in the `workflow_definitions` table:

| Column           | Type         | Description                                                         |
| ---------------- | ------------ | ------------------------------------------------------------------- |
| `id`             | UUID         | Primary key                                                         |
| `name`           | VARCHAR(200) | Unique name (e.g., "Part Lifecycle")                                |
| `version`        | INTEGER      | Definition version                                                  |
| `workflow_type`  | VARCHAR(20)  | Type identifier                                                     |
| `definition`     | JSONB        | States, transitions, and actions                                    |
| `is_active`      | BOOLEAN      | Whether this definition is active                                   |
| `lifecycle_type` | ENUM         | `Free`, `Driven`, or `Driving`                                      |
| `drivers`        | JSONB        | For Driven lifecycles: IDs of Driving lifecycles that can act on it |

### Linking Item Types to Lifecycles

Use the runtime configuration system to assign a lifecycle to an item type:

```json
{
  "itemType": "Part",
  "config": {
    "lifecycleDefinitionId": "<workflow-definition-uuid>"
  }
}
```

**Validation rules**:

- Cannot change to a lifecycle that does not include states items are currently in
- Cannot delete a lifecycle that item types reference
- Cannot remove states from a lifecycle that items are currently using

### Workflow Instances

Each item that participates in a lifecycle gets a `workflow_instances` record:

| Column                   | Type         | Description                                  |
| ------------------------ | ------------ | -------------------------------------------- |
| `workflow_definition_id` | UUID         | References the definition                    |
| `item_id`                | UUID         | The item this instance tracks                |
| `current_state`          | VARCHAR(100) | Current lifecycle state                      |
| `scope_locked`           | BOOLEAN      | For ECOs: whether scope is frozen            |
| `instance_states`        | JSONB        | Override states at instance level (optional) |
| `instance_transitions`   | JSONB        | Override transitions at instance level       |

### Approval Configuration

For states that require approval, configure approvers at the workflow definition level:

The `workflow_state_approvers` table defines who must approve at each state:

| Column                   | Type         | Description                         |
| ------------------------ | ------------ | ----------------------------------- |
| `workflow_definition_id` | UUID         | The workflow definition             |
| `state_id`               | VARCHAR(100) | The state requiring approval        |
| `approver_type`          | VARCHAR(10)  | `user` or `role`                    |
| `approver_id`            | UUID         | References `users.id` or `roles.id` |
| `is_required`            | BOOLEAN      | Whether this approver is mandatory  |

Approval votes are tracked in `workflow_approval_votes` with the vote (`approved` or `rejected`), comments, and timestamp.

### Workflow History

Every state transition is recorded in `workflow_history`:

| Column        | Type         | Description                       |
| ------------- | ------------ | --------------------------------- |
| `instance_id` | UUID         | The workflow instance             |
| `from_state`  | VARCHAR(100) | Previous state                    |
| `to_state`    | VARCHAR(100) | New state                         |
| `action`      | VARCHAR(200) | Transition action name            |
| `actor_id`    | UUID         | User who triggered the transition |
| `comments`    | TEXT         | Optional transition comments      |
| `data`        | JSONB        | Additional transition data        |
| `timestamp`   | TIMESTAMPTZ  | When the transition occurred      |

## AI Settings

Cascadia supports AI-assisted operations with configurable providers. Settings are managed through the admin AI settings API.

### Supported Providers

| Provider    | Description               |
| ----------- | ------------------------- |
| `openai`    | OpenAI (GPT models)       |
| `anthropic` | Anthropic (Claude models) |
| `gemini`    | Google Gemini             |
| `ollama`    | Self-hosted Ollama        |

### Configuring AI

**API endpoint**: `GET /api/admin/ai-settings`

Returns the current global AI configuration and indicates which environment variables are set:

```json
{
  "data": {
    "settings": {
      "enabled": true,
      "provider": "anthropic",
      "config": {
        "provider": "anthropic",
        "apiKey": "sk-ant-a...1234",
        "model": "claude-sonnet-4-20250514"
      }
    },
    "envVars": {
      "openai": false,
      "anthropic": true
    }
  }
}
```

API keys are masked in responses (first 8 and last 4 characters shown).

**API endpoint**: `POST /api/admin/ai-settings`

```json
{
  "enabled": true,
  "provider": "anthropic",
  "config": {
    "provider": "anthropic",
    "apiKey": "sk-ant-api-key-here",
    "model": "claude-sonnet-4-20250514",
    "baseURL": "https://api.anthropic.com"
  }
}
```

### API Key Encryption

When `ENCRYPTION_KEY` is set in the environment, API keys are encrypted before storage using AES encryption. When it is not set, keys are stored as plain text.

### Configuration Precedence

AI settings can come from two sources:

1. **Environment variables**: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`
2. **Database settings**: Stored in the `ai_settings` table via the admin API

The `ai_settings` table stores global settings (where `program_id` is null) as well as optional per-program overrides.

### Testing AI Configuration

**API endpoint**: `POST /api/admin/ai-settings/test`

Tests the configured AI provider by sending a simple request and verifying connectivity.

## Vault Configuration

The vault is Cascadia's file storage system for CAD files, documents, and other attachments.

### Viewing Vault Configuration

**API endpoint**: `GET /api/admin/vault-config`

Returns the effective vault configuration with source tracking (which values come from environment variables vs. database settings):

```json
{
  "data": {
    "type": "local",
    "rootPath": "./vault",
    "source": {
      "rootPath": "default"
    },
    "envVars": {
      "VAULT_TYPE": false,
      "VAULT_ROOT": false,
      "S3_BUCKET": false
    }
  }
}
```

### Storage Types

| Type    | Description                        | Configuration                  |
| ------- | ---------------------------------- | ------------------------------ |
| `local` | Local filesystem storage (default) | `VAULT_ROOT` env or DB setting |
| `s3`    | Amazon S3 or S3-compatible storage | S3 environment variables       |

### Local Storage Configuration

| Source           | Setting      | Description               |
| ---------------- | ------------ | ------------------------- |
| Environment var  | `VAULT_ROOT` | Filesystem path for vault |
| Database setting | `vault_root` | Overrides env var         |
| Default          | `./vault`    | Used if neither is set    |

### S3 Storage Configuration

All S3 settings are configured via environment variables:

| Variable               | Required | Description                       |
| ---------------------- | -------- | --------------------------------- |
| `VAULT_TYPE`           | Yes      | Set to `s3`                       |
| `S3_BUCKET`            | Yes      | S3 bucket name                    |
| `S3_REGION`            | Yes      | AWS region                        |
| `S3_ACCESS_KEY_ID`     | Yes      | AWS access key                    |
| `S3_SECRET_ACCESS_KEY` | Yes      | AWS secret key                    |
| `S3_KEY_PREFIX`        | No       | Prefix for all object keys        |
| `S3_ENDPOINT`          | No       | Custom endpoint (for MinIO, etc.) |
| `S3_FORCE_PATH_STYLE`  | No       | Use path-style URLs (for MinIO)   |

## General Settings

The `settings` table provides a key-value store for application-wide configuration. Each setting has a key, an optional text value, an optional JSON value, and audit fields.

### Database Table

| Column        | Type         | Description                |
| ------------- | ------------ | -------------------------- |
| `id`          | UUID         | Primary key                |
| `key`         | VARCHAR(100) | Setting key (unique)       |
| `value`       | TEXT         | Simple text value          |
| `json_value`  | JSONB        | Complex structured value   |
| `description` | TEXT         | Human-readable description |
| `modified_at` | TIMESTAMPTZ  | Last modification time     |
| `modified_by` | UUID         | User who last modified     |

### API Endpoints

#### Get all settings

```
GET /api/admin/settings
```

#### Get a single setting

```
GET /api/admin/settings?key=vault_root
```

#### Create or update a setting

```
POST /api/admin/settings
Content-Type: application/json

{
  "key": "vault_root",
  "value": "/data/vault",
  "description": "Root path for file vault storage"
}
```

For structured values, use `jsonValue` instead of `value`:

```json
{
  "key": "email_config",
  "jsonValue": {
    "smtp_host": "smtp.example.com",
    "smtp_port": 587
  },
  "description": "Email server configuration"
}
```

#### Delete a setting

```
DELETE /api/admin/settings?key=vault_root
```

### Thread Cache Administration

The thread cache stores precomputed data for performance. Admin endpoints are available for monitoring and maintenance:

| Endpoint                          | Method | Description              |
| --------------------------------- | ------ | ------------------------ |
| `/api/v1/admin/thread-cache/stats`   | GET    | View cache statistics    |
| `/api/v1/admin/thread-cache/warm`    | POST   | Warm the cache           |
| `/api/v1/admin/thread-cache/clear`   | POST   | Clear all cached entries |
| `/api/v1/admin/thread-cache/cleanup` | POST   | Remove expired entries   |

## Configuration Precedence

When multiple configuration sources provide the same setting, they are resolved in this order (highest priority first):

1. **Environment variables** -- Always take precedence (for secrets, infrastructure config)
2. **Database settings** -- Configurable at runtime via admin API
3. **Code defaults** -- Built-in defaults in the application code

This allows infrastructure teams to lock down settings via environment variables while giving administrators flexibility to tune business rules through the UI or API.
