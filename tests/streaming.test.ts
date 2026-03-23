import { describe, it, expect, beforeEach } from "bun:test";
import { buildStreamingResponse } from "../src/streaming.js";
import { resetToolCallCounter } from "../src/parser.js";

function parseSSE(body: string): Array<Record<string, unknown> | string> {
  return body
    .split("\n\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => {
      const data = line.replace("data: ", "");
      if (data === "[DONE]") return "[DONE]";
      return JSON.parse(data);
    });
}

async function getSSEChunks(response: Response) {
  const text = await response.text();
  return parseSSE(text);
}

beforeEach(() => {
  resetToolCallCounter();
});

describe("buildStreamingResponse", () => {
  it("returns correct content type", () => {
    const res = buildStreamingResponse("req-1", "sonnet", "Hello", false);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
  });

  it("returns CORS headers", () => {
    const res = buildStreamingResponse("req-1", "sonnet", "Hello", false);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("streams a text response as word chunks", async () => {
    const res = buildStreamingResponse("req-1", "sonnet", "Hello world", false);
    const chunks = await getSSEChunks(res);

    // Should have: role chunk + word chunks + finish chunk + [DONE]
    expect(chunks.length).toBeGreaterThanOrEqual(4);

    // First chunk: role
    const first = chunks[0] as Record<string, unknown>;
    expect(first.id).toBe("bridge-req-1");
    expect(first.object).toBe("chat.completion.chunk");
    expect(first.model).toBe("claude-sonnet");
    const firstChoice = (first.choices as any[])[0];
    expect(firstChoice.delta.role).toBe("assistant");
    expect(firstChoice.finish_reason).toBeNull();

    // Last real chunk before [DONE]: finish_reason = "stop"
    const lastChunk = chunks[chunks.length - 2] as Record<string, unknown>;
    const lastChoice = (lastChunk.choices as any[])[0];
    expect(lastChoice.finish_reason).toBe("stop");

    // Final: [DONE]
    expect(chunks[chunks.length - 1]).toBe("[DONE]");

    // Content chunks should reconstruct original text
    const contentChunks = chunks.slice(1, -2) as Record<string, unknown>[];
    const reconstructed = contentChunks
      .map((c) => (c.choices as any[])[0].delta.content)
      .join("");
    expect(reconstructed).toBe("Hello world");
  });

  it("streams a tool call response", async () => {
    const content =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>';
    const res = buildStreamingResponse("req-2", "haiku", content, true);
    const chunks = await getSSEChunks(res);

    // Should have: role chunk + tool call chunk + finish chunk + [DONE]
    expect(chunks.length).toBe(4);

    // Tool call chunk
    const toolChunk = chunks[1] as Record<string, unknown>;
    const toolDelta = (toolChunk.choices as any[])[0].delta;
    expect(toolDelta.tool_calls[0].function.name).toBe("get_weather");

    // Finish reason
    const finishChunk = chunks[2] as Record<string, unknown>;
    expect((finishChunk.choices as any[])[0].finish_reason).toBe("tool_calls");
  });

  it("handles empty content", async () => {
    const res = buildStreamingResponse("req-3", "sonnet", "", false);
    const chunks = await getSSEChunks(res);

    // Role + finish + [DONE] (no content chunks for empty string)
    expect(chunks[chunks.length - 1]).toBe("[DONE]");
  });

  it("includes correct model in all chunks", async () => {
    const res = buildStreamingResponse("req-4", "opus", "Test", false);
    const chunks = await getSSEChunks(res);

    for (const chunk of chunks) {
      if (chunk === "[DONE]") continue;
      expect((chunk as Record<string, unknown>).model).toBe("claude-opus");
    }
  });
});
