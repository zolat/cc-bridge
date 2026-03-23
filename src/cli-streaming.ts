import { spawn } from "child_process";
import type { OpenAIMessage, OpenAITool, ClaudeModel } from "./types.js";
import { formatToolDefs } from "./formatter.js";
import { parseResponse } from "./parser.js";

const ENCODER = new TextEncoder();

function sseEvent(data: string): Uint8Array {
  return ENCODER.encode(`data: ${data}\n\n`);
}

function buildUserPrompt(
  messages: OpenAIMessage[],
  tools?: OpenAITool[]
): string {
  const conversationMessages = messages.filter((m) => m.role !== "system");

  let toolSection = "";
  if (tools?.length) {
    toolSection = `\n\nYou have the following tools available:\n${formatToolDefs(tools)}\n\nIf you need to call a tool, respond ONLY with one or more tool_call blocks in this exact format (no other text):\n<tool_call>{"name":"function_name","arguments":{"param":"value"}}</tool_call>\n\nIf you do not need to call a tool, respond normally with plain text.`;
  }

  const conversation = conversationMessages
    .map((m) => {
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
    })
    .join("\n\n");

  return `${toolSection ? toolSection + "\n\n" : ""}${conversation}\n\nRespond to the final message. Provide only your response, no meta-commentary.`;
}

export function buildCliStreamingResponse(
  requestId: string,
  model: ClaudeModel,
  messages: OpenAIMessage[],
  hasTools: boolean,
  tools?: OpenAITool[]
): Response {
  const systemMessages = messages.filter((m) => m.role === "system");
  const systemPrompt =
    systemMessages.map((m) => m.content).join("\n\n") ||
    "You are a helpful assistant.";
  const userPrompt = buildUserPrompt(messages, tools);

  const id = `bridge-${requestId}`;
  const created = Math.floor(Date.now() / 1000);
  const modelName = `claude-${model}`;

  const args = [
    "-p",
    userPrompt,
    "--model",
    model,
    "--output-format",
    "text",
    "--system-prompt",
    systemPrompt,
    "--no-session-persistence",
  ];

  const stream = new ReadableStream({
    start(controller) {
      // Send role chunk immediately
      controller.enqueue(
        sseEvent(
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { role: "assistant" },
                finish_reason: null,
              },
            ],
          })
        )
      );

      const proc = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let fullContent = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        fullContent += text;

        // For tool calls, we need to buffer the full response
        // For text, stream each chunk immediately
        if (!hasTools) {
          controller.enqueue(
            sseEvent(
              JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [
                  {
                    index: 0,
                    delta: { content: text },
                    finish_reason: null,
                  },
                ],
              })
            )
          );
        }
      });

      proc.on("close", (code) => {
        if (hasTools && code === 0) {
          // Parse and emit tool calls as chunks
          const parsed = parseResponse(fullContent, true);
          if (parsed.type === "tool_calls") {
            for (const tc of parsed.toolCalls) {
              controller.enqueue(
                sseEvent(
                  JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: modelName,
                    choices: [
                      {
                        index: 0,
                        delta: {
                          tool_calls: [
                            {
                              index: 0,
                              id: tc.id,
                              type: "function",
                              function: {
                                name: tc.function.name,
                                arguments: tc.function.arguments,
                              },
                            },
                          ],
                        },
                        finish_reason: null,
                      },
                    ],
                  })
                )
              );
            }
            controller.enqueue(
              sseEvent(
                JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [
                    { index: 0, delta: {}, finish_reason: "tool_calls" },
                  ],
                })
              )
            );
          } else {
            // Was text after all — send as one chunk
            controller.enqueue(
              sseEvent(
                JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [
                    {
                      index: 0,
                      delta: { content: parsed.content },
                      finish_reason: null,
                    },
                  ],
                })
              )
            );
            controller.enqueue(
              sseEvent(
                JSON.stringify({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model: modelName,
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                })
              )
            );
          }
        } else if (!hasTools) {
          // Finish chunk for text mode
          controller.enqueue(
            sseEvent(
              JSON.stringify({
                id,
                object: "chat.completion.chunk",
                created,
                model: modelName,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              })
            )
          );
        }

        controller.enqueue(ENCODER.encode("data: [DONE]\n\n"));
        controller.close();
      });

      proc.on("error", (err) => {
        controller.error(err);
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Claude-Model",
    },
  });
}
