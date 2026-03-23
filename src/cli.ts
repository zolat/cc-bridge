import { spawn } from "child_process";
import type { OpenAIMessage, OpenAITool, ClaudeModel } from "./types.js";
import { formatToolDefs } from "./formatter.js";

function buildUserPrompt(messages: OpenAIMessage[], tools?: OpenAITool[]): string {
  const conversationMessages = messages.filter((m) => m.role !== "system");

  let toolSection = "";
  if (tools?.length) {
    toolSection = `\n\nYou have the following tools available:\n${formatToolDefs(tools)}\n\nIf you need to call a tool, respond ONLY with one or more tool_call blocks in this exact format (no other text):\n<tool_call>{"name":"function_name","arguments":{"param":"value"}}</tool_call>\n\nIf you do not need to call a tool, respond normally with plain text.`;
  }

  const conversation = conversationMessages
    .map((m) => {
      if (m.role === "assistant" && m.tool_calls?.length) {
        const calls = m.tool_calls
          .map((tc) => `[assistant called ${tc.function.name}(${tc.function.arguments})]`)
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

function extractSystemPrompt(messages: OpenAIMessage[]): string {
  const systemMessages = messages.filter((m) => m.role === "system");
  return systemMessages.map((m) => m.content).join("\n\n") || "You are a helpful assistant.";
}

export function runClaude(
  messages: OpenAIMessage[],
  model: ClaudeModel,
  tools?: OpenAITool[]
): Promise<string> {
  return new Promise((resolve, reject) => {
    const systemPrompt = extractSystemPrompt(messages);
    const userPrompt = buildUserPrompt(messages, tools);

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

    const proc = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`claude exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

export function runClaudeStreaming(
  messages: OpenAIMessage[],
  model: ClaudeModel,
  tools?: OpenAITool[]
): ReadableStream<Uint8Array> {
  const systemPrompt = extractSystemPrompt(messages);
  const userPrompt = buildUserPrompt(messages, tools);
  const encoder = new TextEncoder();

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

  return new ReadableStream({
    start(controller) {
      const proc = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let buffer = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        buffer += text;

        // Emit each chunk as an SSE word group
        const words = text.split(/(\s+)/);
        for (const word of words) {
          if (!word) continue;
          controller.enqueue(encoder.encode(word));
        }
      });

      proc.on("close", () => {
        controller.close();
      });

      proc.on("error", (err) => {
        controller.error(err);
      });
    },
  });
}
