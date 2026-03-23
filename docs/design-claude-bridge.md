# Design: CC Bridge

## Problem

Local developer tools (Continue, Aider, Open WebUI, custom scripts) need an OpenAI-compatible endpoint for LLM inference. Today this requires either API keys with per-token billing or running local models via Ollama. CC Bridge provides a third option: a local OpenAI-compatible server backed by your Claude Code subscription, giving local apps access to Claude Opus/Sonnet/Haiku without API billing.

## Key Decisions

- **HTTP server**: Bun.serve — single route, zero deps, already the runtime for channel plugins
  - *Alternatives*: Hono (unnecessary routing framework), Fastify/Express (wrong runtime)

- **Dispatch model**: Structured notification with mechanical router — the channel plugin pre-formats the subagent prompt, Claude just spawns subagents without thinking
  - *Alternatives*: Smart router that parses OpenAI payloads (accumulates context, slower dispatch)

- **Response path**: MCP tool call (`send_response`) with request_id, not channel reply — direct correlation, typed params, no parsing
  - *Alternatives*: Channel reply with metadata (harder to correlate, less control)

- **Model selection**: `X-Claude-Model` header (opus/sonnet/haiku), defaults to sonnet — keeps OpenAI request body fully compatible
  - *Alternatives*: Overload `model` field (breaks compatibility with tools that hardcode it)

- **Streaming**: Not in Phase 1. All responses are non-streaming. Most local tools handle this fine.
  - *Phase 2*: Investigate subagent output capture for SSE streaming

- **Concurrency**: Parallel subagents from single router session. Claude Code can spawn multiple subagents concurrently.
  - *Limitation*: Bounded by Claude Code's subagent concurrency limits

## Architecture Overview

```
┌─────────────────────┐
│   Local App          │  POST /v1/chat/completions
│   (Continue, Aider)  │──────────────────────────────┐
└─────────────────────┘                                │
                                                       ▼
┌──────────────────────────────────────────────────────────────┐
│  CC Bridge (Channel Plugin / MCP Server)                 │
│                                                              │
│  ┌─────────────┐    ┌──────────────┐    ┌────────────────┐  │
│  │ Bun.serve   │    │ Request      │    │ Pending Map    │  │
│  │ HTTP server │───▶│ Formatter    │    │ Map<id,Promise>│  │
│  │ :8766       │    │ (→ prompt)   │    │                │  │
│  └─────────────┘    └──────┬───────┘    └───────▲────────┘  │
│                            │                     │           │
│                   channel  │              MCP tool call      │
│                notification│          send_response(id,body) │
│                            ▼                     │           │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                    Claude Code Session                   ││
│  │                                                         ││
│  │  Router (main session) ─── "spawn subagent with this    ││
│  │                              prompt and model"          ││
│  │       │          │          │                           ││
│  │       ▼          ▼          ▼                           ││
│  │  ┌─────────┐┌─────────┐┌─────────┐                    ││
│  │  │SubAgent ││SubAgent ││SubAgent │  (parallel)         ││
│  │  │ req-001 ││ req-002 ││ req-003 │                     ││
│  │  └────┬────┘└────┬────┘└────┬────┘                    ││
│  │       │          │          │                           ││
│  │       └──────────┴──────────┘                          ││
│  │              calls send_response(id, content)           ││
│  └─────────────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────────────┘
```

### Request Flow

1. Local app sends `POST /v1/chat/completions` to `localhost:8766`
2. Bridge generates a `request_id`, creates a pending promise in the map
3. Bridge formats the OpenAI messages array into a subagent prompt string
4. Bridge fires `notifications/claude/channel` with:
   - `content`: the formatted prompt
   - `meta`: `{ request_id, model, source: "claude-bridge" }`
5. Router Claude receives notification, spawns subagent with specified model
6. Subagent processes the prompt, calls `send_response(request_id, content)` MCP tool
7. Bridge's MCP tool handler resolves the pending promise
8. HTTP response returns OpenAI-formatted JSON to the caller

### Prompt Formatting

OpenAI messages array → subagent prompt:

```
<system>
{system message content, or "You are a helpful assistant." if none}
</system>

<conversation>
[user]: {message}
[assistant]: {message}
[user]: {message}
</conversation>

Respond to the final message in the conversation.
When complete, you MUST call the send_response tool with:
- request_id: "{request_id}"
- content: your full response text
Do not include any other commentary. Just respond and call the tool.
```

### Channel Notification Format

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "New inference request.\n\nRequest ID: abc-123\nModel: sonnet\n\nDispatch this to a subagent using the prompt below. Use model 'sonnet'. Do not add any commentary.\n\n---PROMPT---\n{formatted_prompt}\n---END PROMPT---",
    "meta": {
      "request_id": "abc-123",
      "model": "sonnet",
      "source": "claude-bridge"
    }
  }
}
```

### Router Session System Prompt (CLAUDE.md)

The router session needs minimal instructions to stay lightweight:

```markdown
# CC Bridge Router

You are a mechanical request dispatcher. When you receive a channel notification
from source "claude-bridge":

1. Read the request_id and model from the notification
2. Spawn a subagent with the specified model containing the prompt between
   ---PROMPT--- and ---END PROMPT---
3. Do NOT add commentary, analysis, or acknowledgment
4. Dispatch immediately

Multiple requests may arrive. Spawn subagents in parallel when possible.
```

### OpenAI Response Format

```json
{
  "id": "bridge-{request_id}",
  "object": "chat.completion",
  "created": 1711234567,
  "model": "claude-sonnet-4-6",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The response text"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

Note: Token usage is not available from subagents. Fields return 0.

### MCP Tool Definition

```json
{
  "name": "send_response",
  "description": "Send the inference response back to the calling application. MUST be called with the exact request_id provided in the prompt.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "request_id": {
        "type": "string",
        "description": "The request ID from the inference request"
      },
      "content": {
        "type": "string",
        "description": "The full response text"
      }
    },
    "required": ["request_id", "content"]
  }
}
```

## Known Limitations & Mitigations

### Router Context Growth
The router accumulates context with each dispatch. Mitigations:
- Router prompt is minimal — no analysis, just dispatch
- Subagent results don't flow back to router (response goes via MCP tool)
- Long-term: may need periodic session restart or context management

### Concurrency Ceiling
Bounded by Claude Code's subagent parallelism (likely 3-5 concurrent).
For local dev use this is typically sufficient. Excess requests queue.

### Temperature / Max Tokens
Passed as soft instructions in the subagent prompt ("keep response under N tokens").
Not enforced at the model level. Acceptable for local dev use.

### Timeouts
- HTTP requests timeout after 120 seconds (configurable)
- Timed-out requests get cleaned from the pending map
- Returns 504 Gateway Timeout in OpenAI error format

### Session Liveness
- Health endpoint at `GET /health` returns session status
- If Claude Code session dies, all pending requests get rejected with 503
- Bridge detects MCP disconnect and reports unhealthy

## Open Questions / Risks

- **Subagent concurrency limits** — needs empirical testing. How many can run in parallel before Claude Code throttles?
- **Router longevity** — how many dispatches before context compaction degrades routing reliability?
- **Tool approval** — will send_response need manual approval each time, or can it be auto-allowed in settings?
- **Phase 2 streaming** — investigate whether subagent output can be intercepted incrementally

## Implementation Plan

### Phase 1: Core Bridge (MVP)

**Step 1: Project scaffold**
- Initialize project with package.json, tsconfig
- Dependencies: @modelcontextprotocol/sdk
- MCP server boilerplate with channel capability declaration
- .mcp.json configuration

**Step 2: HTTP server + request handling**
- Bun.serve on configurable port (default 8766)
- POST /v1/chat/completions route
- GET /health route
- Request validation (messages array required)
- X-Claude-Model header parsing
- Pending request map with timeout cleanup

**Step 3: Prompt formatter**
- OpenAI messages array → subagent prompt string
- System message extraction
- Conversation history formatting
- send_response instruction injection with request_id

**Step 4: Channel notification dispatch**
- Fire notifications/claude/channel with formatted prompt + metadata
- Wire up send_response MCP tool
- Tool handler resolves pending promises
- OpenAI response JSON formatting

**Step 5: Router configuration**
- CLAUDE.md for the router session with dispatch instructions
- Permission settings for auto-allowing send_response tool
- Test with curl / httpie

**Step 6: Integration testing**
- Test with Continue IDE extension
- Test with a Python script using openai SDK
- Test with Open WebUI
- Verify model routing via header
- Verify concurrent requests dispatch in parallel
- Verify timeout behavior

### Phase 2: Polish (post-MVP)
- Streaming SSE support
- Token usage estimation
- Request logging / history
- Configurable model aliases (map arbitrary model strings)
- Auto-restart on session death
