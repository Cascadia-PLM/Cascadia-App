# Issues: AI Assistant

## Usage log does not capture provider/model or token counts

- **Severity**: minor
- **Area**: code
- **Description**: The `ai_usage_logs` table has columns for `provider`, `model`, `input_tokens`, and `output_tokens`, but the `withPermissionAndAudit` and `withWritePermissionAndAudit` wrappers in `permission-wrapper.ts` never populate these fields. The `db.insert(aiUsageLogs).values(...)` calls only set `sessionId`, `userId`, `toolName`, `toolParams`, `toolResult`, `error`, and `durationMs`. Token usage and model information from the LLM response are not captured.
- **Location**: `packages/core/src/lib/ai/tools/permission-wrapper.ts` lines 80-87 and 147-158
- **Suggestion**: Pass the provider config and token usage information through to the audit logger. The `chat()` response stream may include usage metadata that could be captured in the `onFinish` callback or from stream chunk metadata.
