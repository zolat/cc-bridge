# CC Bridge

Local OpenAI-compatible inference server powered by your Claude Code subscription.

Point any app that speaks the OpenAI chat completions format at `localhost:8766` and get Claude Opus, Sonnet, or Haiku — no API keys, no per-token billing.

```
Local App (Continue, Aider, Open WebUI, scripts)
        │
        │  POST /v1/chat/completions
        ▼
   CC Bridge (channel plugin)
        │
        │  channel notification
        ▼
   Claude Code (router session)
        │
        │  spawns background subagent
        ▼
   Subagent (opus/sonnet/haiku)
        │
        │  send_response tool
        ▼
   CC Bridge → HTTP response → Local App
```

## How it works

CC Bridge is a [Claude Code channel plugin](https://docs.anthropic.com/en/docs/claude-code/channels) that runs two things:

1. **An HTTP server** on `localhost:8766` that accepts OpenAI-formatted requests
2. **An MCP server** that communicates with your Claude Code session

When a request comes in, the plugin formats it as a channel notification. Your Claude Code session acts as a lightweight router — it spawns a subagent with the requested model, and when the subagent responds, routes the result back through an MCP tool call that resolves the HTTP response.

Subagents run in the background, so the router can dispatch multiple requests in parallel.

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with an active subscription (Pro/Max)
- [Bun](https://bun.sh) runtime
- Channels feature (research preview as of March 2026)

## Setup

```bash
git clone https://github.com/zolat/cc-bridge.git
cd cc-bridge
bun install
```

## Usage

Start Claude Code with the channel plugin loaded:

```bash
claude --dangerously-load-development-channels server:cc-bridge
```

That's it. The bridge is now listening on `http://localhost:8766`.

### Test it

```bash
curl -s http://localhost:8766/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```

### Select a model

Use the `X-Claude-Model` header. Defaults to `sonnet` if omitted.

```bash
curl -s http://localhost:8766/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Claude-Model: haiku" \
  -d '{"messages":[{"role":"user","content":"Hello!"}]}'
```

Available models: `opus`, `sonnet`, `haiku`

### Use with the OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8766/v1",
    api_key="not-needed"  # required by SDK, ignored by bridge
)

response = client.chat.completions.create(
    model="claude-sonnet",  # ignored, use X-Claude-Model header or defaults to sonnet
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

### Tool calling

CC Bridge supports OpenAI-format tool calling:

```bash
curl -s http://localhost:8766/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "What is the weather in Tokyo?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get weather for a city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

The response includes `tool_calls` in standard OpenAI format. Send tool results back as `role: "tool"` messages to complete the loop.

### Use with local tools

Point any OpenAI-compatible tool at `http://localhost:8766/v1`:

- **[Continue](https://continue.dev)** — set as a custom OpenAI provider
- **[Aider](https://aider.chat)** — `aider --openai-api-base http://localhost:8766/v1`
- **[Open WebUI](https://openwebui.com)** — add as an OpenAI-compatible connection
- **Custom scripts** — any OpenAI SDK client with `base_url` override

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI format) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check + pending request count |

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_BRIDGE_PORT` | `8766` | HTTP server port |
| `CLAUDE_BRIDGE_TIMEOUT` | `120000` | Request timeout in ms |

## Architecture

```
src/
  server.ts      Entry point
  http.ts        HTTP server (Bun.serve)
  mcp.ts         MCP server + send_response tool
  formatter.ts   OpenAI messages → subagent prompt
  parser.ts      Subagent response → OpenAI tool_calls
  response.ts    OpenAI response/error builders
  pending.ts     Request lifecycle management
  types.ts       TypeScript interfaces
  config.ts      Environment configuration
```

The router session (your Claude Code instance) uses a minimal `CLAUDE.md` that instructs it to mechanically dispatch requests to background subagents. A lightweight model like Haiku works well as the router — it dispatches fast and uses minimal context.

## Demo

Open `demo.html` in a browser for a chat UI with built-in tool demos (weather, calculator, dice roller).

## Limitations

- **No streaming** — responses are returned complete, not streamed via SSE. Phase 2 feature.
- **Token usage** — `usage` fields in responses return 0. Token counts aren't available from subagents.
- **Temperature/max_tokens** — these OpenAI parameters are not enforced at the model level.
- **Router context growth** — the router session accumulates context over time. For very long sessions, you may need to restart.
- **Concurrency** — bounded by Claude Code's background agent limits.

## How is this different from the Claude API?

The Claude API charges per token. CC Bridge routes through your existing Claude Code subscription — no additional cost, no API keys to manage. The trade-off is higher latency (~10-15s per request) and the constraints of running through a local Claude Code session.

## Note on channels

Claude Code channels are in **research preview** (launched March 2026). The `--dangerously-load-development-channels` flag is required for custom channel plugins that aren't published to the official marketplace. The channel protocol may change as the feature matures.

## License

MIT
