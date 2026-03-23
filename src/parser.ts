import type { OpenAIToolCall, ParsedResponse } from "./types.js";

let toolCallCounter = 0;

export function resetToolCallCounter(): void {
  toolCallCounter = 0;
}

export function parseResponse(
  raw: string,
  hasTools: boolean
): ParsedResponse {
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
      return { type: "text", content: raw, toolCalls: [] };
    }
  }

  const textContent = raw.replace(toolCallRegex, "").trim() || null;

  return { type: "tool_calls", content: textContent, toolCalls };
}
