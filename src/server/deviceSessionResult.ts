import { logger } from "../utils/logger";

/**
 * The tools that acquire a device and mint a device session, returning its
 * `sessionUuid` in the tool RESULT (not the request args). Both the direct MCP
 * server (`src/server/index.ts`) and the daemon proxy (`DaemonMcpProxy`) must
 * bind the session these tools mint — the proxy additionally heartbeats it so
 * the daemon does not reap a result-minted session (issue #5689).
 */
export const DEVICE_SESSION_ACQUISITION_TOOLS = [
  "getAndroid",
  "getApple",
  "startDevice",
  "provisionDevice",
] as const;

/**
 * The subset of `DEVICE_SESSION_ACQUISITION_TOOLS` worth naming in recovery
 * guidance: the tools a client with a lost session can call DIRECTLY, with only
 * an optional `deviceId`, to reacquire. Two of the four acquisition tools are
 * disqualified for different reasons:
 *
 * - `startDevice` is `hidden: true` (`src/server/deviceTools.ts`), so it never
 *   appears in `tools/list` and cannot be enabled through `setToolEnabled`
 *   either — a client following advice that named it had nothing to call.
 * - `provisionDevice` is discoverable and callable on a default connection
 *   (`defaultEnabled: true`), but it is not directly-actionable recovery advice:
 *   it requires a full device `spec` and a caller-generated `operationId`, so a
 *   lost-session client cannot just "call provisionDevice" to get back a
 *   session the way it can with getAndroid/getApple.
 *
 * Advertised in every `session_ownership_lost` / `no_active_device_session`
 * recovery payload (`src/server/index.ts`, `src/server/proxyServer.ts`) and in
 * the prose that accompanies them (`src/daemon/daemonMcpProxy.ts`). Pinned to
 * the registry by `test/server/deviceSessionRecoveryTools.test.ts`.
 */
export const DEVICE_SESSION_RECOVERY_TOOLS = ["getAndroid", "getApple"] as const;

/** The prose form of {@link DEVICE_SESSION_RECOVERY_TOOLS} for error messages. */
export const DEVICE_SESSION_RECOVERY_PROMPT = `Call ${
  DEVICE_SESSION_RECOVERY_TOOLS.length > 2
    ? `${DEVICE_SESSION_RECOVERY_TOOLS.slice(0, -1).join(", ")}, or ${DEVICE_SESSION_RECOVERY_TOOLS[DEVICE_SESSION_RECOVERY_TOOLS.length - 1]}`
    : DEVICE_SESSION_RECOVERY_TOOLS.join(" or ")
} to acquire a new device session.`;

/** Whether `name` is a device-session acquisition tool (see above). */
export function isDeviceSessionAcquisitionTool(name: string): boolean {
  return (DEVICE_SESSION_ACQUISITION_TOOLS as readonly string[]).includes(name);
}

/**
 * Extract the session id a device-start tool minted, from its MCP tool result.
 * The id rides in the first `text` content item as JSON `{ "sessionUuid": "..." }`
 * (issue #5870 renamed the key from `sessionId`, which is still read as a
 * fallback for any legacy envelope). Returns undefined when the result is not a
 * device-start envelope.
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
    const payload = JSON.parse(text.text) as { sessionUuid?: unknown; sessionId?: unknown };
    const minted = payload.sessionUuid ?? payload.sessionId;
    return typeof minted === "string" && minted.trim().length > 0 ? minted : undefined;
  } catch (error) {
    logger.debug("[MCP] Device-start response did not contain JSON", { error });
    return undefined;
  }
}

/**
 * The error codes a tool RESULT uses to say the device session it names is gone
 * — emitted as ordinary `isError: true` envelopes by `src/server/index.ts`
 * (`session_ownership_lost`) and `src/server/proxyServer.ts`
 * (`session_ownership_lost`, `no_active_device_session`). A proxy must not bind
 * or refresh the lease of a session an answer like this just declared dead.
 */
const DEVICE_SESSION_INVALID_ERROR_CODES: readonly string[] = [
  "session_ownership_lost",
  "no_active_device_session",
];

/**
 * Whether an MCP tool result is one of the session-invalid error envelopes
 * above. Anything else — including every ordinary tool failure, which carries
 * prose rather than a JSON error payload — is false, because those still ran
 * against a LIVE session.
 */
export function declaresDeviceSessionInvalid(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("isError" in result)) {
    return false;
  }
  if ((result as { isError?: unknown }).isError !== true) {
    return false;
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return false;
  }
  return content.some((item) => {
    if (
      !item ||
      typeof item !== "object" ||
      (item as { type?: unknown }).type !== "text" ||
      typeof (item as { text?: unknown }).text !== "string"
    ) {
      return false;
    }
    const text = (item as { text: string }).text;
    // Cheap pre-filter: an ordinary tool failure answers with prose, so this
    // keeps JSON.parse (and its catch) off the common path entirely.
    if (!DEVICE_SESSION_INVALID_ERROR_CODES.some((code) => text.includes(code))) {
      return false;
    }
    try {
      const payload = JSON.parse(text) as { error?: { code?: unknown } };
      return (
        typeof payload?.error?.code === "string" &&
        DEVICE_SESSION_INVALID_ERROR_CODES.includes(payload.error.code)
      );
    } catch (error) {
      // A result that merely mentions the code in prose is not the envelope.
      logger.debug("[MCP] Session-invalid probe: error result was not JSON", { error });
      return false;
    }
  });
}
