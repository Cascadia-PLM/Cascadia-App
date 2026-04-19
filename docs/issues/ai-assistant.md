# Issues: AI Assistant

## Usage log does not capture provider/model or token counts

- **Severity**: minor
- **Area**: code
- **Description**: The `ai_usage_logs` table has columns for `provider`, `model`, `input_tokens`, and `output_tokens`, but the `withPermissionAndAudit` and `withWritePermissionAndAudit` wrappers in `permission-wrapper.ts` never populate these fields. The `db.insert(aiUsageLogs).values(...)` calls only set `sessionId`, `userId`, `toolName`, `toolParams`, `toolResult`, `error`, and `durationMs`. Token usage and model information from the LLM response are not captured.
- **Location**: `src/lib/ai/tools/permission-wrapper.ts` lines 80-87 and 147-158
- **Suggestion**: Pass the provider config and token usage information through to the audit logger. The `chat()` response stream may include usage metadata that could be captured in the `onFinish` callback or from stream chunk metadata.

## Architecture doc diverges from implementation

- **Severity**: cosmetic
- **Area**: docs
- **Description**: The existing architecture document (`docs/ai-chatbot-architecture-tanstack.md`) was written as a planning document and contains code examples that differ from the actual implementation. For example, it references `openaiText()` / `anthropicText()` adapter functions, while the implementation uses `createOpenaiChat()` / `createAnthropicChat()`. Tool definitions use `parameters` in the doc but `inputSchema` in the code. The doc also discusses features like Gemini and Ollama as if they work.
- **Location**: `docs/ai-chatbot-architecture-tanstack.md`
- **Suggestion**: Either update the architecture doc to match the implementation, or add a note at the top indicating it is a planning document and pointing to the feature documentation at `docs/features/ai-assistant.md` for the current state.
