import { PORT } from "./config.js";
import { PendingRequestMap } from "./pending.js";
import { createMcpServer, connectTransport } from "./mcp.js";
import { createHttpServer } from "./http.js";

const pending = new PendingRequestMap();
const mcp = createMcpServer(pending);
const http = createHttpServer(PORT, pending, mcp);

console.error(`[cc-bridge] HTTP server listening on http://localhost:${PORT}`);
console.error(`[cc-bridge] Endpoints:`);
console.error(`[cc-bridge]   POST /v1/chat/completions`);
console.error(`[cc-bridge]   GET  /v1/models`);
console.error(`[cc-bridge]   GET  /health`);

await connectTransport(mcp);
