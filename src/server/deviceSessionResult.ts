import {
  ACQUIRE_NEW_SESSION_NEXT_ACTION,
  DEVICE_SESSION_RECOVERY_TOOLS,
} from "../models/deviceSessionRecovery";
import { readToolEnvelopePayload } from "./toolEnvelopePayload";
import { logger } from "../utils/logger";
import type { SessionReleaseSnapshot } from "../daemon/sessionManager";
import {
  SESSION_OWNERSHIP_LOST_CODE,
  sessionReleaseThatCancelledCall,
} from "../daemon/sessionReleasedDuringCall";
import { DAEMON_SESSION_SUSPECT_CODE } from "../daemon/types";
import { SUSPECT_GRACE_MS } from "../daemon/sessionLivenessWindows";
import {
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  DEVICE_SHUTTING_DOWN_CODE,
  SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
} from "../daemon/deviceAcquisitionRefusals";

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
  // A lapsed owner lease is held for the suspect grace before the release (#10051), so the limit
  // the owner actually exceeded is lease plus grace; a never-heartbeated session has no grace.
  const limitMs =
    release.releaseReason === "heartbeat-timeout" ? timeoutMs + SUSPECT_GRACE_MS : timeoutMs;
  return `${message} No heartbeat for ${ageMs} ms (limit ${limitMs} ms; set AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS to change).`;
}

/**
 * The fields every terminal-session refusal shares (#11098). The session UUID cannot be retried, so
 * `retryable` is false and `nextAction` says what to do instead.
 */
export function terminalSessionRefusalFields(ownerPid?: number) {
  return {
    retryable: false as const,
    nextAction: ACQUIRE_NEW_SESSION_NEXT_ACTION,
    ...(ownerPid === undefined ? {} : { ownerPid }),
    recovery: {
      action: "acquire_replacement_session" as const,
      tools: [...DEVICE_SESSION_RECOVERY_TOOLS],
    },
  };
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
      code: SESSION_OWNERSHIP_LOST_CODE,
      message: appendHeartbeatExpiryMessage(message, release),
      sessionUuid,
      reason,
      ...terminalSessionRefusalFields(release?.ownerPid),
      ...(release ? { release } : {}),
    },
  };
}

/**
 * The ownership-loss envelope for a call cancelled because its session was released under it
 * (#11322), or undefined when `cancelReason` (the tracker's record of why the call was aborted)
 * is anything else. The session is terminal, exactly as a call arriving after the release is told.
 * The control socket answers the same refusal from the error's own fields (#11381); both go
 * through {@link sessionReleaseThatCancelledCall}.
 */
export function sessionReleasedDuringCallPayload(
  cancelReason: unknown,
): ReturnType<typeof sessionOwnershipLostPayload> | undefined {
  const released = sessionReleaseThatCancelledCall(cancelReason);
  if (!released) {
    return undefined;
  }
  return sessionOwnershipLostPayload({
    message: released.message,
    sessionUuid: released.sessionUuid,
    reason: released.releaseReason,
  });
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
 * The session and device a successful `setActiveDevice` selected. Its payload is
 * `{ message, deviceId, sessionUuid? }`, not a device-start envelope, so
 * {@link getDeviceSessionIdFromResult} never finds its session (#11235): the proxy kept
 * replaying its previous binding and untargeted calls stayed on the old device.
 */
export function getActiveDeviceSelectionFromResult(
  result: unknown,
): { sessionUuid: string; deviceId?: string } | undefined {
  const payload = readToolEnvelopePayload(result)?.payload;
  const sessionUuid = payload?.sessionUuid;
  if (typeof sessionUuid !== "string" || sessionUuid.trim().length === 0) {
    return undefined;
  }
  const deviceId = payload?.deviceId;
  return typeof deviceId === "string" && deviceId.trim().length > 0
    ? { sessionUuid, deviceId }
    : { sessionUuid };
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

/**
 * Whether `name` binds a device and so can be refused while the device's previous session is still
 * cleaning up (#10960): the acquisition tools plus `setActiveDevice`. Only these are safe to
 * re-forward on that refusal, because a refused bind never reached a device.
 */
export function isDeviceBindingTool(name: string): boolean {
  return name === "setActiveDevice" || isDeviceSessionAcquisitionTool(name);
}

/**
 * The retry hint of a typed `device_cleanup_in_progress` or `device_shutting_down` refusal result,
 * when it is one. Both are bind refusals that never reached a device and clear on their own
 * (#10960, #11111).
 */
export function readDeviceCleanupInProgressRefusal(
  result: unknown,
): { retryAfterMs?: number } | undefined {
  if (!result || typeof result !== "object" || !("isError" in result) || result.isError !== true) {
    return undefined;
  }
  const payload = readToolEnvelopePayload(result)?.payload;
  if (
    !payload ||
    (payload.code !== DEVICE_CLEANUP_IN_PROGRESS_CODE && payload.code !== DEVICE_SHUTTING_DOWN_CODE)
  ) {
    return undefined;
  }
  const { retryAfterMs } = payload;
  return typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
    ? { retryAfterMs }
    : {};
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
 * (`session_ownership_lost`), `src/server/proxyServer.ts`
 * (`session_ownership_lost`, `no_active_device_session`) and `shapeToolCallError`
 * (`session_terminal_release_in_progress`, #11296). A proxy must not bind
 * or refresh the lease of a session an answer like this just declared dead.
 */
const DEVICE_SESSION_INVALID_ERROR_CODES: readonly string[] = [
  "session_ownership_lost",
  "no_active_device_session",
  SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
];

/**
 * Whether one error-payload object says its session is terminal: a recognised code, or the
 * `nextAction: "acquire_new_session"` every terminal-session refusal carries (#11098).
 */
function isSessionInvalidFields(fields: Record<string, unknown>): boolean {
  return (
    (typeof fields.code === "string" && DEVICE_SESSION_INVALID_ERROR_CODES.includes(fields.code)) ||
    fields.nextAction === ACQUIRE_NEW_SESSION_NEXT_ACTION
  );
}

/**
 * Whether an MCP tool result is one of the session-invalid error envelopes
 * above, in either wire shape: nested `{ error: { code, nextAction } }`
 * (`sessionOwnershipLostPayload`) or top-level `{ code, nextAction, error: "<prose>" }`
 * (`shapeToolCallError`). Anything else — including every ordinary tool failure, which carries
 * prose rather than a JSON error payload — is false, because those still ran
 * against a LIVE session.
 */
export function declaresDeviceSessionInvalid(result: unknown): boolean {
  if (!result || typeof result !== "object" || (result as { isError?: unknown }).isError !== true) {
    return false;
  }
  const content = (result as { content?: unknown }).content;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured && !Array.isArray(content)) {
    return false;
  }
  // A result that merely mentions a code in prose is not the envelope; the debug-only parse
  // callback keeps routine prose failures quiet.
  const payload = readToolEnvelopePayload(result, (error) => {
    logger.debug("[MCP] Session-invalid probe: error result was not JSON", { error });
  })?.payload;
  if (!payload) {
    return false;
  }
  if (isSessionInvalidFields(payload)) {
    return true;
  }
  const nested = payload.error;
  return (
    nested !== null &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    isSessionInvalidFields(nested as Record<string, unknown>)
  );
}
