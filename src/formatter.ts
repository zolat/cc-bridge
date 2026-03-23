import type { OpenAIMessage, OpenAITool } from "./types.js";

export function formatToolDefs(tools: OpenAITool[]): string {
  return tools
    .map((t) => {
      const params = t.function.parameters
        ? `\n  Parameters: ${JSON.stringify(t.function.parameters)}`
        : "";
      return `- ${t.function.name}: ${t.function.description || "No description"}${params}`;
    })
    .join("\n");
}

export function formatMessage(m: OpenAIMessage): string {
  if (m.role === "assistant" && m.tool_calls?.length) {
    const calls = m.tool_calls
      .map(
        (tc) =>
          `[assistant called ${tc.function.name}(${tc.function.arguments})]`
      )
      .join("\n");
    const prefix = m.content ? `[assistant]: ${m.content}\n` : "";
    return `${prefix}${calls}`;
  }
  if (m.role === "tool") {
    return `[tool result]: ${m.content}`;
  }
  return `[${m.role}]: ${m.content || ""}`;
}

export function formatSubagentPrompt(
  messages: OpenAIMessage[],
  tools?: OpenAITool[]
): string {
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemPrompt =
    systemMessages.map((m) => m.content).join("\n\n") ||
    "You are a helpful assistant.";

  const conversationMessages = messages.filter((m) => m.role !== "system");
  const conversation = conversationMessages.map(formatMessage).join("\n\n");

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

export function formatChannelNotification(
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
