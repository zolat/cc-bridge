import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PendingRequestMap } from "./pending.js";

export function createMcpServer(pending: PendingRequestMap): McpServer {
  const mcp = new McpServer(
    {
      name: "cc-bridge",
      version: "0.1.0",
    },
    {
      capabilities: {
        experimental: {
          "claude/channel": {},
        },
        tools: {},
      },
    }
  );

  mcp.tool(
    "send_response",
    "Send the inference response back to the calling application. MUST be called with the exact request_id provided in the prompt.",
    {
      request_id: z
        .string()
        .describe("The request ID from the inference request"),
      content: z.string().describe("The full response text"),
    },
    async ({ request_id, content }) => {
      const resolved = pending.resolve(request_id, content);

      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: No pending request found for ID ${request_id}. It may have timed out.`,
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Response delivered for request ${request_id}.`,
          },
        ],
      };
    }
  );

  return mcp;
}

export async function connectTransport(mcp: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
}
