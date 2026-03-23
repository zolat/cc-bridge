import { PORT, MODE } from "./config.js";
import { createHttpServer } from "./http.js";

console.error(`[cc-bridge] Mode: ${MODE}`);
console.error(`[cc-bridge] HTTP server listening on http://localhost:${PORT}`);
console.error(`[cc-bridge] Endpoints:`);
console.error(`[cc-bridge]   POST /v1/chat/completions`);
console.error(`[cc-bridge]   GET  /v1/models`);
console.error(`[cc-bridge]   GET  /health`);

if (MODE === "channel") {
  const { PendingRequestMap } = await import("./pending.js");
  const { createMcpServer, connectTransport } = await import("./mcp.js");

  const pending = new PendingRequestMap();
  const mcp = createMcpServer(pending);
  createHttpServer(PORT, pending, mcp);
  await connectTransport(mcp);
} else {
  createHttpServer(PORT, null, null);
  console.error(`[cc-bridge] CLI mode — no Claude Code session needed`);
  // Keep process alive
  await new Promise(() => {});
}
