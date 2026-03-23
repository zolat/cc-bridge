import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// --- Types ---

interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

interface PendingRequest {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  model: string;
  createdAt: number;
}

// --- Config ---

const PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || "8766", 10);
const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_BRIDGE_TIMEOUT || "120000",
  10
);
const VALID_MODELS = ["opus", "sonnet", "haiku"] as const;
type ClaudeModel = (typeof VALID_MODELS)[number];

// --- State ---

const pendingRequests = new Map<string, PendingRequest>();
let requestCounter = 0;

function generateRequestId(): string {
  return `br-${Date.now()}-${++requestCounter}`;
}

// --- Prompt Formatter ---

function formatToolDefs(tools: OpenAITool[]): string {
  return tools
    .map((t) => {
      const params = t.function.parameters
        ? `\n  Parameters: ${JSON.stringify(t.function.parameters)}`
        : "";
      return `- ${t.function.name}: ${t.function.description || "No description"}${params}`;
    })
    .join("\n");
}

function formatMessage(m: OpenAIMessage): string {
  if (m.role === "assistant" && m.tool_calls?.length) {
    const calls = m.tool_calls
      .map(
        (tc) =>
          `<tool_call>{"id":"${tc.id}","name":"${tc.function.name}","arguments":${tc.function.arguments}}</tool_call>`
      )
      .join("\n");
    return `[assistant]: ${m.content || ""}\n${calls}`;
  }
  if (m.role === "tool") {
    return `[tool (id=${m.tool_call_id})]: ${m.content}`;
  }
  return `[${m.role}]: ${m.content || ""}`;
}

function formatSubagentPrompt(
  messages: OpenAIMessage[],
  tools?: OpenAITool[]
): string {
  // Extract system message
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemPrompt =
    systemMessages.map((m) => m.content).join("\n\n") ||
    "You are a helpful assistant.";

  // Format conversation (non-system messages)
  const conversationMessages = messages.filter((m) => m.role !== "system");
  const conversation = conversationMessages
    .map(formatMessage)
    .join("\n\n");

  // Tool instructions
  let toolSection = "";
  if (tools?.length) {
    toolSection = `

<available_tools>
${formatToolDefs(tools)}
</available_tools>

If you need to call a tool, respond ONLY with one or more tool_call blocks in this exact format (no other text):
<tool_call>{"name":"function_name","arguments":{"param":"value"}}</tool_call>

If you do not need to call a tool, respond normally with plain text.`;
  }

  return `<system>
${systemPrompt}
</system>
${toolSection}

<conversation>
${conversation}
</conversation>

Respond to the final message in the conversation. Provide only your response, no meta-commentary.`;
}

function formatChannelNotification(
  prompt: string,
  requestId: string,
  model: string
): string {
  return `New inference request.

Request ID: ${requestId}
Model: ${model}

Steps:
1. Spawn a subagent (model: ${model}) with the prompt between ---PROMPT--- and ---END PROMPT---
2. When the subagent returns, call send_response with request_id "${requestId}" and the subagent's response as content.

---PROMPT---
${prompt}
---END PROMPT---`;
}

interface ParsedResponse {
  type: "text" | "tool_calls";
  content: string | null;
  toolCalls: OpenAIToolCall[];
}

let toolCallCounter = 0;

function parseResponse(raw: string, hasTools: boolean): ParsedResponse {
  if (!hasTools) {
    return { type: "text", content: raw, toolCalls: [] };
  }

  const toolCallRegex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const matches = [...raw.matchAll(toolCallRegex)];

  if (matches.length === 0) {
    return { type: "text", content: raw, toolCalls: [] };
  }

  const toolCalls: OpenAIToolCall[] = [];
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]);
      toolCalls.push({
        id: `call_${++toolCallCounter}`,
        type: "function",
        function: {
          name: parsed.name,
          arguments:
            typeof parsed.arguments === "string"
              ? parsed.arguments
              : JSON.stringify(parsed.arguments),
        },
      });
    } catch {
      // If JSON parse fails, treat whole response as text
      return { type: "text", content: raw, toolCalls: [] };
    }
  }

  // Any text outside tool_call tags
  const textContent = raw.replace(toolCallRegex, "").trim() || null;

  return { type: "tool_calls", content: textContent, toolCalls };
}

function buildOpenAIResponse(
  requestId: string,
  model: string,
  content: string,
  hasTools: boolean = false
) {
  const parsed = parseResponse(content, hasTools);

  const message: Record<string, unknown> = {
    role: "assistant",
  };

  if (parsed.type === "tool_calls") {
    message.content = parsed.content;
    message.tool_calls = parsed.toolCalls;
  } else {
    message.content = parsed.content;
  }

  return {
    id: `bridge-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: `claude-${model}`,
    choices: [
      {
        index: 0,
        message,
        finish_reason: parsed.type === "tool_calls" ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}

function buildOpenAIError(status: number, message: string, type: string) {
  return {
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  };
}

function parseModel(header: string | null): ClaudeModel {
  if (header && VALID_MODELS.includes(header as ClaudeModel)) {
    return header as ClaudeModel;
  }
  return "sonnet";
}

// --- MCP Server ---

const mcp = new McpServer(
  {
    name: "cc-bridge",
    version: "0.1.0",
  },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
      },
      tools: {},
    },
  }
);

// Register send_response tool
mcp.tool(
  "send_response",
  "Send the inference response back to the calling application. MUST be called with the exact request_id provided in the prompt.",
  {
    request_id: z
      .string()
      .describe("The request ID from the inference request"),
    content: z.string().describe("The full response text"),
  },
  async ({ request_id, content }) => {
    const pending = pendingRequests.get(request_id);
    if (!pending) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: No pending request found for ID ${request_id}. It may have timed out.`,
          },
        ],
      };
    }

    // Resolve the pending HTTP request
    clearTimeout(pending.timer);
    pendingRequests.delete(request_id);
    pending.resolve(content);

    return {
      content: [
        {
          type: "text" as const,
          text: `Response delivered for request ${request_id}.`,
        },
      ],
    };
  }
);

// --- HTTP Server ---

const httpServer = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers for local apps
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Claude-Model",
    };

    // Handle preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (url.pathname === "/health" && req.method === "GET") {
      return Response.json(
        {
          status: "ok",
          pending_requests: pendingRequests.size,
          uptime_seconds: Math.floor(process.uptime()),
        },
        { headers: corsHeaders }
      );
    }

    // OpenAI-compatible models list
    if (url.pathname === "/v1/models" && req.method === "GET") {
      return Response.json(
        {
          object: "list",
          data: VALID_MODELS.map((m) => ({
            id: `claude-${m}`,
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "anthropic",
          })),
        },
        { headers: corsHeaders }
      );
    }

    // Chat completions
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      let body: OpenAIChatRequest;
      try {
        body = (await req.json()) as OpenAIChatRequest;
      } catch {
        return Response.json(
          buildOpenAIError(400, "Invalid JSON body", "invalid_request_error"),
          { status: 400, headers: corsHeaders }
        );
      }

      // Validate messages
      if (!body.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
        return Response.json(
          buildOpenAIError(
            400,
            "messages is required and must be a non-empty array",
            "invalid_request_error"
          ),
          { status: 400, headers: corsHeaders }
        );
      }

      // Reject streaming for now
      if (body.stream) {
        return Response.json(
          buildOpenAIError(
            400,
            "Streaming is not supported in this version. Set stream: false or omit it.",
            "invalid_request_error"
          ),
          { status: 400, headers: corsHeaders }
        );
      }

      const model = parseModel(req.headers.get("x-claude-model"));
      const requestId = generateRequestId();

      // Format the prompt
      const subagentPrompt = formatSubagentPrompt(body.messages, body.tools);
      const notificationContent = formatChannelNotification(
        subagentPrompt,
        requestId,
        model
      );

      // Create pending promise
      const responsePromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error("Request timed out"));
        }, REQUEST_TIMEOUT_MS);

        pendingRequests.set(requestId, {
          resolve,
          reject,
          timer,
          model,
          createdAt: Date.now(),
        });
      });

      // Fire channel notification
      try {
        await mcp.server.notification({
          method: "notifications/claude/channel",
          params: {
            content: notificationContent,
            meta: {
              request_id: requestId,
              model,
              source: "cc-bridge",
              chat_id: "bridge",
              message_id: requestId,
              user: "bridge",
              ts: new Date().toISOString(),
            },
          },
        });
      } catch (err) {
        // Clean up pending request
        const pending = pendingRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingRequests.delete(requestId);
        }
        console.error("[cc-bridge] Failed to send channel notification:", err);
        return Response.json(
          buildOpenAIError(
            503,
            "Claude Code session is not connected",
            "service_unavailable"
          ),
          { status: 503, headers: corsHeaders }
        );
      }

      // Wait for response
      try {
        const content = await responsePromise;
        const hasTools = !!(body.tools && body.tools.length > 0);
        return Response.json(
          buildOpenAIResponse(requestId, model, content, hasTools),
          { headers: corsHeaders }
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Internal server error";
        const status = message.includes("timed out") ? 504 : 500;
        return Response.json(
          buildOpenAIError(
            status,
            message,
            status === 504 ? "timeout_error" : "internal_error"
          ),
          { status, headers: corsHeaders }
        );
      }
    }

    // 404 for everything else
    return Response.json(
      buildOpenAIError(404, `Not found: ${url.pathname}`, "not_found"),
      { status: 404, headers: corsHeaders }
    );
  },
});

console.error(`[cc-bridge] HTTP server listening on http://localhost:${PORT}`);
console.error(`[cc-bridge] Endpoints:`);
console.error(`[cc-bridge]   POST /v1/chat/completions`);
console.error(`[cc-bridge]   GET  /v1/models`);
console.error(`[cc-bridge]   GET  /health`);

// --- Start MCP Transport ---

const transport = new StdioServerTransport();
await mcp.connect(transport);
