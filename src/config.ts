export const PORT = parseInt(process.env.CLAUDE_BRIDGE_PORT || "8766", 10);
export const REQUEST_TIMEOUT_MS = parseInt(
  process.env.CLAUDE_BRIDGE_TIMEOUT || "120000",
  10
);
