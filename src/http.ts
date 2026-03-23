import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { OpenAIChatRequest, ClaudeModel } from "./types.js";
import { VALID_MODELS } from "./types.js";
import { formatSubagentPrompt, formatChannelNotification } from "./formatter.js";
import { buildOpenAIResponse, buildOpenAIError, parseModel } from "./response.js";
import { buildStreamingResponse } from "./streaming.js";
import { buildCliStreamingResponse } from "./cli-streaming.js";
import { runClaude } from "./cli.js";
import type { PendingRequestMap } from "./pending.js";
import { REQUEST_TIMEOUT_MS, MODE } from "./config.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Claude-Model",
};

export function createHttpServer(
  port: number,
  pending: PendingRequestMap | null,
  mcp: McpServer | null
) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }

      if (url.pathname === "/health" && req.method === "GET") {
        return Response.json(
          {
            status: "ok",
            mode: MODE,
            pending_requests: pending?.size ?? 0,
            uptime_seconds: Math.floor(process.uptime()),
          },
          { headers: CORS_HEADERS }
        );
      }

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
          { headers: CORS_HEADERS }
        );
      }

      if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
        return handleChatCompletions(req, pending, mcp);
      }

      return Response.json(
        buildOpenAIError(404, `Not found: ${url.pathname}`, "not_found"),
        { status: 404, headers: CORS_HEADERS }
      );
    },
  });
}

async function handleChatCompletions(
  req: Request,
  pending: PendingRequestMap | null,
  mcp: McpServer | null
): Promise<Response> {
  let body: OpenAIChatRequest;
  try {
    body = (await req.json()) as OpenAIChatRequest;
  } catch {
    return Response.json(
      buildOpenAIError(400, "Invalid JSON body", "invalid_request_error"),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  if (
    !body.messages ||
    !Array.isArray(body.messages) ||
    body.messages.length === 0
  ) {
    return Response.json(
      buildOpenAIError(
        400,
        "messages is required and must be a non-empty array",
        "invalid_request_error"
      ),
      { status: 400, headers: CORS_HEADERS }
    );
  }

  const wantsStream = !!body.stream;
  const model = parseModel(req.headers.get("x-claude-model"));
  const hasTools = !!(body.tools && body.tools.length > 0);

  if (MODE === "cli") {
    return handleCliMode(body, model, wantsStream, hasTools);
  }

  return handleChannelMode(body, model, wantsStream, hasTools, pending!, mcp!);
}

// --- CLI Mode ---

async function handleCliMode(
  body: OpenAIChatRequest,
  model: ClaudeModel,
  wantsStream: boolean,
  hasTools: boolean
): Promise<Response> {
  const requestId = `cli-${Date.now()}`;

  if (wantsStream) {
    return buildCliStreamingResponse(requestId, model, body.messages, hasTools, body.tools);
  }

  try {
    const content = await runClaude(body.messages, model, body.tools);
    return Response.json(
      buildOpenAIResponse(requestId, model, content, hasTools),
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Internal server error";
    return Response.json(
      buildOpenAIError(500, message, "internal_error"),
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

// --- Channel Mode ---

async function handleChannelMode(
  body: OpenAIChatRequest,
  model: ClaudeModel,
  wantsStream: boolean,
  hasTools: boolean,
  pending: PendingRequestMap,
  mcp: McpServer
): Promise<Response> {
  const requestId = pending.generateId();

  const subagentPrompt = formatSubagentPrompt(body.messages, body.tools);
  const notificationContent = formatChannelNotification(
    subagentPrompt,
    requestId,
    model
  );

  const responsePromise = pending.add(requestId, model, REQUEST_TIMEOUT_MS);

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
    pending.cancel(requestId);
    console.error("[cc-bridge] Failed to send channel notification:", err);
    return Response.json(
      buildOpenAIError(
        503,
        "Claude Code session is not connected",
        "service_unavailable"
      ),
      { status: 503, headers: CORS_HEADERS }
    );
  }

  try {
    const content = await responsePromise;

    if (wantsStream) {
      return buildStreamingResponse(requestId, model, content, hasTools);
    }

    return Response.json(
      buildOpenAIResponse(requestId, model, content, hasTools),
      { headers: CORS_HEADERS }
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
      { status, headers: CORS_HEADERS }
    );
  }
}
