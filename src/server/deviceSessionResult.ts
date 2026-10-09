import { DEVICE_SESSION_RECOVERY_TOOLS } from "../models/deviceSessionRecovery";
import { readToolEnvelopePayload } from "./toolEnvelopePayload";
import { logger } from "../utils/logger";
import type { SessionReleaseSnapshot } from "../daemon/sessionManager";
import { DAEMON_SESSION_SUSPECT_CODE } from "../daemon/types";

/**
 * The tools that acquire a device and mint a device session, returning its
 * session UUID in the tool RESULT (not the request args). Both the direct MCP
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

export { DEVICE_SESSION_RECOVERY_TOOLS } from "../models/deviceSessionRecovery";

/** The prose form of {@link DEVICE_SESSION_RECOVERY_TOOLS} for error messages. */
export const DEVICE_SESSION_RECOVERY_PROMPT = `Call ${
  DEVICE_SESSION_RECOVERY_TOOLS.length > 2
    ? `${DEVICE_SESSION_RECOVERY_TOOLS.slice(0, -1).join(", ")}, or ${DEVICE_SESSION_RECOVERY_TOOLS[DEVICE_SESSION_RECOVERY_TOOLS.length - 1]}`
    : DEVICE_SESSION_RECOVERY_TOOLS.join(" or ")
} to acquire a new device session.`;

/** Append the recorded heartbeat leash only when heartbeat expiry caused the release. */
export function appendHeartbeatExpiryMessage(
  message: string,
  release?: SessionReleaseSnapshot,
): string {
  if (
    !release ||
    (release.releaseReason !== "heartbeat-timeout" &&
      release.releaseReason !== "missing-first-heartbeat")
  ) {
    return message;
  }
  const { ageMs, timeoutMs } = release.heartbeat;
  return `${message} No heartbeat for ${ageMs} ms (limit ${timeoutMs} ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).`;
}

/** Build the ownership-loss envelope shared by the direct MCP server and daemon proxy. */
export function sessionOwnershipLostPayload({
  message,
  sessionUuid,
  reason,
  release,
}: {
  message: string;
  sessionUuid: string;
  reason: string;
  release?: SessionReleaseSnapshot;
}) {
  return {
    error: {
      code: "session_ownership_lost",
      message: appendHeartbeatExpiryMessage(message, release),
      sessionUuid,
      reason,
      retryable: true,
      recovery: {
        action: "acquire_replacement_session",
        tools: [...DEVICE_SESSION_RECOVERY_TOOLS],
      },
      ...(release ? { release } : {}),
    },
  };
}

/** Whether `name` is a device-session acquisition tool (see above). */
export function isDeviceSessionAcquisitionTool(name: string): boolean {
  return (DEVICE_SESSION_ACQUISITION_TOOLS as readonly string[]).includes(name);
}

/**
 * Extract the session id a device-start tool minted, from its MCP tool result.
 * The canonical device description carries it in `runtime.session.sessionUuid`.
 * The provisionDevice envelope's distinct top-level `sessionId` remains
 * accepted. Returns undefined when the result is not a device-start envelope.
 */
export function getDeviceSessionIdFromResult(result: unknown): string | undefined {
  const payload = readToolEnvelopePayload(result)?.payload;
  const runtime = payload?.runtime;
  const session =
    runtime && typeof runtime === "object" ? (runtime as { session?: unknown }).session : undefined;
  const sessionUuid =
    session && typeof session === "object"
      ? (session as { sessionUuid?: unknown }).sessionUuid
      : undefined;
  const minted = sessionUuid ?? payload?.sessionId;
  return typeof minted === "string" && minted.trim().length > 0 ? minted : undefined;
}

/**
 * The device description a device-start tool result carries. getAndroid/getApple/startDevice
 * answer with the description itself; provisionDevice nests it under `device` beside its
 * top-level `sessionId` (#10821).
 */
function readDeviceDescription(result: unknown): Record<string, unknown> | undefined {
  const payload = readToolEnvelopePayload(result)?.payload;
  if (!payload || "platform" in payload || "runtime" in payload) {
    return payload;
  }
  const nested = payload.device;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    return nested as Record<string, unknown>;
  }
  return undefined;
}

/**
 * The device id a device-start tool result describes, from `runtime.deviceId` beside the session
 * UUID. A proxy records it so a liveness handover can name the device (#10053).
 */
export function getDeviceIdFromResult(result: unknown): string | undefined {
  const runtime = readDeviceDescription(result)?.runtime;
  if (!runtime || typeof runtime !== "object" || !("deviceId" in runtime)) {
    return undefined;
  }
  const { deviceId } = runtime;
  return typeof deviceId === "string" && deviceId.trim().length > 0 ? deviceId : undefined;
}

/**
 * The platform a device-start tool result describes (the device description's top-level
 * `platform`). A proxy records it so a call routed by a `platform` selector can tell which of its
 * sessions it reached (#10692).
 */
export function getDevicePlatformFromResult(result: unknown): "android" | "ios" | undefined {
  const platform = readDeviceDescription(result)?.platform;
  return platform === "android" || platform === "ios" ? platform : undefined;
}

/**
 * Whether a tool RESULT is the daemon's refusal of a session held inside its suspect window
 * (#10051). The session still exists and its owner can restore it, so unlike
 * {@link declaresDeviceSessionInvalid} this is evidence recovery is still possible.
 */
export function declaresDeviceSessionSuspect(result: unknown): boolean {
  if (!result || typeof result !== "object" || !("isError" in result) || result.isError !== true) {
    return false;
  }
  const error = readToolEnvelopePayload(result)?.payload?.error;
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === DAEMON_SESSION_SUSPECT_CODE
  );
}

/** The session a suspect refusal names and how long the daemon keeps it reserved. */
export interface DeviceSessionSuspectRefusal {
  sessionUuid: string;
  remainingMs: number;
}

/** The details of a {@link declaresDeviceSessionSuspect} refusal, when it carries them. */
export function readDeviceSessionSuspectRefusal(
  result: unknown,
): DeviceSessionSuspectRefusal | undefined {
  if (!declaresDeviceSessionSuspect(result)) {
    return undefined;
  }
  const error = readToolEnvelopePayload(result)?.payload?.error;
  if (
    !error ||
    typeof error !== "object" ||
    !("sessionUuid" in error) ||
    typeof error.sessionUuid !== "string" ||
    !("remainingMs" in error) ||
    typeof error.remainingMs !== "number" ||
    !Number.isFinite(error.remainingMs)
  ) {
    return undefined;
  }
  return { sessionUuid: error.sessionUuid, remainingMs: error.remainingMs };
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
