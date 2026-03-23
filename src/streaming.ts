import { parseResponse } from "./parser.js";

const ENCODER = new TextEncoder();

function sseEvent(data: string): Uint8Array {
  return ENCODER.encode(`data: ${data}\n\n`);
}

export function buildStreamingResponse(
  requestId: string,
  model: string,
  content: string,
  hasTools: boolean
): Response {
  const parsed = parseResponse(content, hasTools);
  const created = Math.floor(Date.now() / 1000);
  const id = `bridge-${requestId}`;
  const modelName = `claude-${model}`;

  const chunks: Uint8Array[] = [];

  if (parsed.type === "tool_calls") {
    // Role chunk
    chunks.push(
      sseEvent(
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: parsed.content },
              finish_reason: null,
            },
          ],
        })
      )
    );

    // One chunk per tool call
    for (const tc of parsed.toolCalls) {
      chunks.push(
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

    // Finish chunk
    chunks.push(
      sseEvent(
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model: modelName,
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })
      )
    );
  } else {
    // Role chunk
    chunks.push(
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

    // Split content into word-level chunks for natural pacing
    const words = (parsed.content || "").split(/(\s+)/);
    for (const word of words) {
      if (!word) continue;
      chunks.push(
        sseEvent(
          JSON.stringify({
            id,
            object: "chat.completion.chunk",
            created,
            model: modelName,
            choices: [
              {
                index: 0,
                delta: { content: word },
                finish_reason: null,
              },
            ],
          })
        )
      );
    }

    // Finish chunk
    chunks.push(
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

  // [DONE] sentinel
  chunks.push(ENCODER.encode("data: [DONE]\n\n"));

  // Concatenate all chunks into a single buffer
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }

  return new Response(body, {
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
