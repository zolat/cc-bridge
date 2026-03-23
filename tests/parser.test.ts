import { describe, it, expect, beforeEach } from "bun:test";
import { parseResponse, resetToolCallCounter } from "../src/parser.js";

beforeEach(() => {
  resetToolCallCounter();
});

describe("parseResponse", () => {
  it("returns text when hasTools is false", () => {
    const result = parseResponse("Hello world", false);
    expect(result.type).toBe("text");
    expect(result.content).toBe("Hello world");
    expect(result.toolCalls).toEqual([]);
  });

  it("returns text when hasTools but no tool_call tags", () => {
    const result = parseResponse("Just a normal response", true);
    expect(result.type).toBe("text");
    expect(result.content).toBe("Just a normal response");
    expect(result.toolCalls).toEqual([]);
  });

  it("parses a single tool call", () => {
    const raw = '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>';
    const result = parseResponse(raw, true);
    expect(result.type).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("get_weather");
    expect(result.toolCalls[0].function.arguments).toBe('{"city":"Tokyo"}');
    expect(result.toolCalls[0].id).toBe("call_1");
    expect(result.toolCalls[0].type).toBe("function");
  });

  it("parses multiple tool calls", () => {
    const raw =
      '<tool_call>{"name":"get_weather","arguments":{"city":"Tokyo"}}</tool_call>\n' +
      '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>';
    const result = parseResponse(raw, true);
    expect(result.type).toBe("tool_calls");
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0].id).toBe("call_1");
    expect(result.toolCalls[1].id).toBe("call_2");
    expect(result.toolCalls[0].function.arguments).toBe('{"city":"Tokyo"}');
    expect(result.toolCalls[1].function.arguments).toBe('{"city":"Paris"}');
  });

  it("preserves text content outside tool_call tags", () => {
    const raw =
      'Let me check that.\n<tool_call>{"name":"calc","arguments":{"expr":"2+2"}}</tool_call>';
    const result = parseResponse(raw, true);
    expect(result.type).toBe("tool_calls");
    expect(result.content).toBe("Let me check that.");
    expect(result.toolCalls).toHaveLength(1);
  });

  it("sets content to null when only tool calls", () => {
    const raw = '<tool_call>{"name":"fn","arguments":{}}</tool_call>';
    const result = parseResponse(raw, true);
    expect(result.content).toBeNull();
  });

  it("falls back to text on invalid JSON", () => {
    const raw = "<tool_call>not valid json</tool_call>";
    const result = parseResponse(raw, true);
    expect(result.type).toBe("text");
    expect(result.content).toBe(raw);
    expect(result.toolCalls).toEqual([]);
  });

  it("stringifies object arguments", () => {
    const raw =
      '<tool_call>{"name":"fn","arguments":{"key":"val"}}</tool_call>';
    const result = parseResponse(raw, true);
    expect(result.toolCalls[0].function.arguments).toBe('{"key":"val"}');
  });

  it("passes string arguments through", () => {
    const raw =
      '<tool_call>{"name":"fn","arguments":"already a string"}</tool_call>';
    const result = parseResponse(raw, true);
    expect(result.toolCalls[0].function.arguments).toBe("already a string");
  });

  it("increments tool call IDs across calls", () => {
    parseResponse(
      '<tool_call>{"name":"a","arguments":{}}</tool_call>',
      true
    );
    const result = parseResponse(
      '<tool_call>{"name":"b","arguments":{}}</tool_call>',
      true
    );
    expect(result.toolCalls[0].id).toBe("call_2");
  });
});
