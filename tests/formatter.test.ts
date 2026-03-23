import { describe, it, expect } from "bun:test";
import {
  formatMessage,
  formatToolDefs,
  formatSubagentPrompt,
  formatChannelNotification,
} from "../src/formatter.js";
import type { OpenAIMessage, OpenAITool } from "../src/types.js";

describe("formatMessage", () => {
  it("formats a user message", () => {
    const msg: OpenAIMessage = { role: "user", content: "Hello" };
    expect(formatMessage(msg)).toBe("[user]: Hello");
  });

  it("formats an assistant message", () => {
    const msg: OpenAIMessage = { role: "assistant", content: "Hi there" };
    expect(formatMessage(msg)).toBe("[assistant]: Hi there");
  });

  it("formats a tool result message", () => {
    const msg: OpenAIMessage = {
      role: "tool",
      content: '{"temp": 22}',
      tool_call_id: "call_1",
    };
    expect(formatMessage(msg)).toBe('[tool result]: {"temp": 22}');
  });

  it("formats an assistant message with tool calls", () => {
    const msg: OpenAIMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
          },
        },
      ],
    };
    const result = formatMessage(msg);
    expect(result).toBe('[assistant called get_weather({"city":"Tokyo"})]');
  });

  it("formats assistant tool calls with preceding content", () => {
    const msg: OpenAIMessage = {
      role: "assistant",
      content: "Let me check that.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: {
            name: "calculate",
            arguments: '{"expression":"2+2"}',
          },
        },
      ],
    };
    const result = formatMessage(msg);
    expect(result).toContain("[assistant]: Let me check that.");
    expect(result).toContain('[assistant called calculate({"expression":"2+2"})]');
  });

  it("formats multiple tool calls", () => {
    const msg: OpenAIMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Tokyo"}' },
        },
        {
          id: "call_2",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Paris"}' },
        },
      ],
    };
    const result = formatMessage(msg);
    expect(result).toContain("get_weather");
    expect(result.match(/assistant called/g)?.length).toBe(2);
  });

  it("handles null content gracefully", () => {
    const msg: OpenAIMessage = { role: "assistant", content: null };
    expect(formatMessage(msg)).toBe("[assistant]: ");
  });
});

describe("formatToolDefs", () => {
  it("formats a single tool", () => {
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a city",
        },
      },
    ];
    const result = formatToolDefs(tools);
    expect(result).toBe("- get_weather: Get weather for a city");
  });

  it("includes parameters when present", () => {
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: {
          name: "calculate",
          description: "Evaluate math",
          parameters: {
            type: "object",
            properties: { expression: { type: "string" } },
          },
        },
      },
    ];
    const result = formatToolDefs(tools);
    expect(result).toContain("- calculate: Evaluate math");
    expect(result).toContain("Parameters:");
    expect(result).toContain('"expression"');
  });

  it("uses fallback description when missing", () => {
    const tools: OpenAITool[] = [
      { type: "function", function: { name: "mystery" } },
    ];
    expect(formatToolDefs(tools)).toBe("- mystery: No description");
  });

  it("formats multiple tools", () => {
    const tools: OpenAITool[] = [
      { type: "function", function: { name: "a", description: "Tool A" } },
      { type: "function", function: { name: "b", description: "Tool B" } },
    ];
    const result = formatToolDefs(tools);
    expect(result).toContain("- a: Tool A");
    expect(result).toContain("- b: Tool B");
  });
});

describe("formatSubagentPrompt", () => {
  it("uses default system prompt when none provided", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "Hello" },
    ];
    const result = formatSubagentPrompt(messages);
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("[user]: Hello");
  });

  it("extracts system message", () => {
    const messages: OpenAIMessage[] = [
      { role: "system", content: "You are a pirate." },
      { role: "user", content: "Ahoy" },
    ];
    const result = formatSubagentPrompt(messages);
    expect(result).toContain("You are a pirate.");
    expect(result).not.toContain("[system]");
    expect(result).toContain("[user]: Ahoy");
  });

  it("includes tool section when tools provided", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "What time is it?" },
    ];
    const tools: OpenAITool[] = [
      {
        type: "function",
        function: { name: "get_time", description: "Get current time" },
      },
    ];
    const result = formatSubagentPrompt(messages, tools);
    expect(result).toContain("<available_tools>");
    expect(result).toContain("get_time");
    expect(result).toContain("<tool_call>");
  });

  it("omits tool section when no tools", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "Hi" },
    ];
    const result = formatSubagentPrompt(messages);
    expect(result).not.toContain("<available_tools>");
    expect(result).not.toContain("<tool_call>");
  });

  it("formats multi-turn conversation", () => {
    const messages: OpenAIMessage[] = [
      { role: "user", content: "Capital of France?" },
      { role: "assistant", content: "Paris." },
      { role: "user", content: "And Germany?" },
    ];
    const result = formatSubagentPrompt(messages);
    expect(result).toContain("[user]: Capital of France?");
    expect(result).toContain("[assistant]: Paris.");
    expect(result).toContain("[user]: And Germany?");
  });
});

describe("formatChannelNotification", () => {
  it("includes request id and model", () => {
    const result = formatChannelNotification("test prompt", "br-123", "sonnet");
    expect(result).toContain("Request ID: br-123");
    expect(result).toContain("Model: sonnet");
  });

  it("wraps prompt in delimiters", () => {
    const result = formatChannelNotification("my prompt", "br-1", "haiku");
    expect(result).toContain("---PROMPT---");
    expect(result).toContain("my prompt");
    expect(result).toContain("---END PROMPT---");
  });

  it("includes dispatch instructions", () => {
    const result = formatChannelNotification("p", "br-1", "opus");
    expect(result).toContain("send_response");
    expect(result).toContain('"br-1"');
  });
});
