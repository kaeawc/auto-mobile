import { logger } from "../utils/logger";

/**
 * The tools that acquire a device and mint a device session, returning its
 * `sessionId` in the tool RESULT (not the request args). Both the direct MCP
 * server (`src/server/index.ts`) and the daemon proxy (`DaemonMcpProxy`) must
 * bind the session these tools mint — the proxy additionally heartbeats it so
 * the daemon does not reap a result-minted session (issue #5689).
 */
export const DEVICE_SESSION_ACQUISITION_TOOLS = [
  "getAndroid",
  "getApple",
  "startDevice",
] as const;

/** Whether `name` is a device-session acquisition tool (see above). */
export function isDeviceSessionAcquisitionTool(name: string): boolean {
  return (DEVICE_SESSION_ACQUISITION_TOOLS as readonly string[]).includes(name);
}

/**
 * Extract the `sessionId` a device-start tool minted, from its MCP tool result.
 * The id rides in the first `text` content item as JSON `{ "sessionId": "..." }`.
 * Returns undefined when the result is not a device-start envelope.
 */
export function getDeviceSessionIdFromResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || !("content" in result)) {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content.find(
    (item) =>
      item &&
      typeof item === "object" &&
      "type" in item &&
      (item as { type?: unknown }).type === "text" &&
      "text" in item &&
      typeof (item as { text?: unknown }).text === "string",
  ) as { text: string } | undefined;
  if (!text) {
    return undefined;
  }
  try {
    const payload = JSON.parse(text.text) as { sessionId?: unknown };
    return typeof payload.sessionId === "string" && payload.sessionId.trim().length > 0
      ? payload.sessionId
      : undefined;
  } catch (error) {
    logger.debug("[MCP] Device-start response did not contain JSON", { error });
    return undefined;
  }
}
