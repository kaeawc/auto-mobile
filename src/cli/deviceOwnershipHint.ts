import { DEVICE_OWNED_BY_OTHER_SESSION_CODE } from "../daemon/inputDeviceOwnership";
import { AMBIGUOUS_DEVICE_TARGET_CODE } from "../daemon/ambiguousDeviceTargetRefusal";
import { SESSION_OWNERSHIP_LOST_CODE } from "../daemon/sessionReleasedDuringCall";
import { ENV } from "../config/env";
import {
  MAX_CLI_SESSION_IDLE_TIMEOUT_MS,
  getCliSessionIdleTimeoutMs,
} from "../daemon/wire/constants";
import { isDeviceSessionAcquisitionTool } from "../daemon/deviceSessionResult";
import { staticToolDeclaresInput } from "../daemon/staticToolDefinitions";
import {
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DEVICE_SHUTTING_DOWN_CODE,
  SESSION_NO_LONGER_OWNS_DEVICE_CODE,
  SESSION_REBINDING_CODE,
  SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
} from "../models/deviceAcquisitionRefusals";

function refusalCode(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  // Tool-call refusals carry `code`; a deleteDevice precondition failure nests it in `failure`.
  const failure = record.failure;
  if (failure && typeof failure === "object") {
    return (failure as Record<string, unknown>).code;
  }
  // Ownership-loss payloads (session_ownership_lost, ...) nest the code under `error`.
  const error = record.error;
  return (
    record.code ??
    (error && typeof error === "object" ? (error as Record<string, unknown>).code : undefined)
  );
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : undefined;
}

/** The release reason of an ownership-loss payload, which nests it under `error`. */
function ownershipLossReason(payload: unknown): unknown {
  return payloadRecord(payloadRecord(payload)?.error)?.reason;
}

function formatMinutes(ms: number): string {
  const minutes = Math.round((ms / 60_000) * 10) / 10;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/**
 * A `--cli` session idle-released between invocations (#16882): name the window it had and the
 * variable that lengthens it, since the refusal itself only says `cli-idle-timeout`.
 */
function cliIdleTimeoutHint(idleTimeoutMs: number): string {
  return (
    `Hint: this --cli session was released after ${formatMinutes(idleTimeoutMs)} without a ` +
    "control call (reads do not count), so its session UUID cannot be used again. Acquire a new " +
    "session with getAndroid, getApple or startDevice. To keep a session across longer gaps, set " +
    `${ENV.CLI_SESSION_IDLE_TIMEOUT_MS.name} (milliseconds, at most ` +
    `${formatMinutes(MAX_CLI_SESSION_IDLE_TIMEOUT_MS)}) in the environment of every --cli call.`
  );
}

/** Each candidate as `deviceId (platform)`, skipping malformed entries. */
function candidateList(payload: unknown): string[] {
  const candidates = payloadRecord(payload)?.candidates;
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates.flatMap((candidate) => {
    const record = payloadRecord(candidate);
    if (typeof record?.deviceId !== "string") {
      return [];
    }
    return [
      typeof record.platform === "string"
        ? `${record.deviceId} (${record.platform})`
        : record.deviceId,
    ];
  });
}

/**
 * A sessionless call that matched several devices (#16882): `--platform` cannot pick between two
 * devices of one platform, so name the device ids the caller can pass.
 */
function ambiguousDeviceTargetHint(payload: unknown): string {
  const candidates = candidateList(payload);
  const listed = candidates.length > 0 ? ` Candidates: ${candidates.join(", ")}.` : "";
  return (
    "Hint: more than one device matches this call. Re-run with --deviceId <id> to pick one, or " +
    `with --session-uuid <uuid> to use a device your session holds.${listed}`
  );
}

/** Refusals whose CLI remedy does not depend on the payload or the tool. */
const FIXED_REFUSAL_HINTS: ReadonlyMap<string, string> = new Map([
  [
    DEVICE_CLEANUP_IN_PROGRESS_CODE,
    "Hint: the device's previous session is still finishing its cleanup. Re-run the command " +
      "after the retryAfterMs in the error has passed; nothing else needs to change.",
  ],
  [
    DEVICE_SHUTTING_DOWN_CODE,
    "Hint: the device is being shut down. Re-run the command after the retryAfterMs in the " +
      "error has passed, once the shutdown has finished.",
  ],
  [
    SESSION_TERMINAL_RELEASE_IN_PROGRESS_CODE,
    "Hint: this session is being released because its device is being shut down, so its " +
      "session UUID cannot be used again. Retrying with the same --session-uuid will not " +
      "succeed; acquire the device again under a new session instead.",
  ],
  [
    SESSION_REBINDING_CODE,
    "Hint: the device's session is moving to another device. Re-run the command after the " +
      "retryAfterMs in the error has passed, once the rebind has settled.",
  ],
  [
    SESSION_NO_LONGER_OWNS_DEVICE_CODE,
    "Hint: the session no longer holds this device; it was rebound or released. Check who " +
      "holds the device now with --daemon active-sessions before re-running the command.",
  ],
  [
    DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
    "Hint: another AutoMobile daemon on this host is using the device. Re-run after it " +
      "releases the device, or pass another deviceId.",
  ],
]);

/**
 * A `--cli` invocation is a separate process, so a call without `--session-uuid` is sessionless
 * and the daemon refuses it on a device another session holds (#10743, #10783, #10785). The
 * refusal message names the rule; this adds the CLI-shaped remedy. Returns undefined for any
 * other failure.
 */
export function cliDeviceOwnershipHint(
  payload: unknown,
  toolName: string,
  cliIdleTimeoutMs: () => number = getCliSessionIdleTimeoutMs,
): string | undefined {
  const code = refusalCode(payload);
  if (code === SESSION_OWNERSHIP_LOST_CODE && ownershipLossReason(payload) === "cli-idle-timeout") {
    return cliIdleTimeoutHint(cliIdleTimeoutMs());
  }
  if (code === AMBIGUOUS_DEVICE_TARGET_CODE) {
    return ambiguousDeviceTargetHint(payload);
  }
  const fixedHint = typeof code === "string" ? FIXED_REFUSAL_HINTS.get(code) : undefined;
  if (fixedHint !== undefined) {
    return fixedHint;
  }
  if (code !== DEVICE_OWNED_BY_OTHER_SESSION_CODE) {
    return undefined;
  }
  if (isDeviceSessionAcquisitionTool(toolName)) {
    // The CLI drops --session-uuid for acquisition tools (they mint their own session), so
    // "re-run with --session-uuid" would be discarded (#11096).
    return (
      `Hint: another session holds the device, and ${toolName} cannot join it: acquisition ` +
      "tools mint their own session and the CLI ignores --session-uuid for them. If that " +
      "session is yours, skip re-acquiring and pass --session-uuid <uuid> to your follow-up " +
      "calls; to see who holds the device, run --daemon active-sessions (releasing a session " +
      "that is not yours can break another agent's work); otherwise wait for the holder to " +
      "release it."
    );
  }
  // A tool that declares a `force` input accepts it to override a held-device refusal.
  const forceHint = staticToolDeclaresInput(toolName, "force")
    ? ` To stop it anyway, pass --force true.`
    : "";
  return (
    "Hint: a device a session holds takes calls only from that session. Re-run with " +
    "--session-uuid <uuid>, the sessionUuid that getAndroid, getApple or startDevice returned " +
    `when the device was acquired, or wait for the holder to release it.${forceHint}`
  );
}
