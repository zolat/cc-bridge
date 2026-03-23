import { describe, it, expect, beforeEach } from "bun:test";
import {
  buildOpenAIResponse,
  buildOpenAIError,
  parseModel,
} from "../src/response.js";
import { resetToolCallCounter } from "../src/parser.js";

beforeEach(() => {
  resetToolCallCounter();
});

describe("buildOpenAIResponse", () => {
  it("builds a text response", () => {
    const result = buildOpenAIResponse("req-1", "sonnet", "Hello!");
    expect(result.id).toBe("bridge-req-1");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("claude-sonnet");
    expect(result.choices).toHaveLength(1);
    expect(result.choices[0].message.content).toBe("Hello!");
    expect(result.choices[0].message.role).toBe("assistant");
    expect(result.choices[0].finish_reason).toBe("stop");
  });

  it("builds a tool call response", () => {
    const content =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>';
    const result = buildOpenAIResponse("req-2", "haiku", content, true);
    expect(result.choices[0].finish_reason).toBe("tool_calls");
    expect(result.choices[0].message.tool_calls).toHaveLength(1);
    const tc = (result.choices[0].message.tool_calls as any[])[0];
    expect(tc.function.name).toBe("get_weather");
  });

  it("returns text when hasTools but no tool_call tags in content", () => {
    const result = buildOpenAIResponse(
      "req-3",
      "sonnet",
      "No tools needed",
      true
    );
    expect(result.choices[0].finish_reason).toBe("stop");
    expect(result.choices[0].message.content).toBe("No tools needed");
  });

  it("includes zero usage stats", () => {
    const result = buildOpenAIResponse("req-4", "opus", "test");
    expect(result.usage.prompt_tokens).toBe(0);
    expect(result.usage.completion_tokens).toBe(0);
    expect(result.usage.total_tokens).toBe(0);
  });

  it("sets created timestamp", () => {
    const before = Math.floor(Date.now() / 1000);
    const result = buildOpenAIResponse("req-5", "sonnet", "test");
    const after = Math.floor(Date.now() / 1000);
    expect(result.created).toBeGreaterThanOrEqual(before);
    expect(result.created).toBeLessThanOrEqual(after);
  });
});

describe("buildOpenAIError", () => {
  it("builds an error object", () => {
    const result = buildOpenAIError(400, "Bad request", "invalid_request_error");
    expect(result.error.message).toBe("Bad request");
    expect(result.error.type).toBe("invalid_request_error");
    expect(result.error.param).toBeNull();
    expect(result.error.code).toBeNull();
  });
});

describe("parseModel", () => {
  it("returns sonnet as default", () => {
    expect(parseModel(null)).toBe("sonnet");
  });

  it("returns sonnet for invalid model", () => {
    expect(parseModel("gpt-4")).toBe("sonnet");
  });

  it("returns valid models", () => {
    expect(parseModel("opus")).toBe("opus");
    expect(parseModel("sonnet")).toBe("sonnet");
    expect(parseModel("haiku")).toBe("haiku");
  });
});
