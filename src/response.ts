import { parseResponse } from "./parser.js";
import type { ClaudeModel } from "./types.js";
import { VALID_MODELS } from "./types.js";

export function buildOpenAIResponse(
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

export function buildOpenAIError(
  status: number,
  message: string,
  type: string
) {
  return {
    error: {
      message,
      type,
      param: null,
      code: null,
    },
  };
}

export function parseModel(header: string | null): ClaudeModel {
  if (header && VALID_MODELS.includes(header as ClaudeModel)) {
    return header as ClaudeModel;
  }
  return "sonnet";
}
