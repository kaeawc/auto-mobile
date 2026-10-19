/**
 * The one session key for the stateless daemon MCP layer (#4678, owner decision
 * 2026-10-17). Every caller that needs per-session tool binding sends its session
 * handle in this header on each request: the socket server forwards the socket
 * session id, and the desktop client sends one id per app session. The in-band
 * `__mcpSessionId` argument stays accepted.
 */
export const MCP_SESSION_KEY_HEADER = "x-auto-mobile-mcp-session-id";

/** Reads the session key from a Node-style lower-cased header bag. */
export function readMcpSessionKey(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const raw = headers[MCP_SESSION_KEY_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
