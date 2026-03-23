export interface OpenAIToolFunction {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface OpenAITool {
  type: "function";
  function: OpenAIToolFunction;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?:
    | "auto"
    | "none"
    | { type: "function"; function: { name: string } };
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
}

export interface PendingRequestEntry {
  resolve: (content: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  model: string;
  createdAt: number;
}

export interface ParsedResponse {
  type: "text" | "tool_calls";
  content: string | null;
  toolCalls: OpenAIToolCall[];
}

export const VALID_MODELS = ["opus", "sonnet", "haiku"] as const;
export type ClaudeModel = (typeof VALID_MODELS)[number];
