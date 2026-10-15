import { ActionableError } from "../../models";
import { errorMessage } from "../../utils/describeUnknownError";
import { shellQuote } from "../../utils/shellQuote";
import { releaseVersion } from "../../utils/mcpVersion";
import { DaemonUnavailableError } from "../client";
import { type BuildIdentity, describeBuildIdentity } from "../buildIdentity";
import { DAEMON_TOOL_UNAVAILABLE_CODE } from "../types";
import { DEVICE_SESSION_RECOVERY_PROMPT } from "../../server/deviceSessionResult";
import type { SessionReleaseSnapshot } from "../sessionManager";
import {
  livenessHandoverMessage,
  livenessHandoverPayload,
  type LivenessHandover,
} from "../proxyLivenessRecovery";
import type { NotFoundAnswerOutcome } from "../daemonMcpProxy";

export type VersionMismatchReason =
  | "autoStartDisabled"
  | "cooldown"
  | "daemonNewer"
  | "nonNumeric"
  | "restartMismatch";

export type BuildMismatchReason = "autoStartDisabled" | "cooldown" | "restartMismatch";

/** Preserve the registration boundary so claim refusals keep their narrower retry policy. */
class ManagedExecutionRegistrationError extends ActionableError {
  constructor(cause: unknown) {
    super(`Managed execution registration failed: ${errorMessage(cause)}`, { cause });
  }
}

/** A transport failed before dispatch, rather than a reconciliation policy gate. */
class DaemonPreflightConnectionError extends DaemonUnavailableError {
  constructor(readonly cause: DaemonUnavailableError) {
    super(cause.message);
    this.name = "DaemonPreflightConnectionError";
  }
}

/**
 * A non-idempotent `tools/call` failed without structured proof that the daemon
 * never dispatched it (e.g. the connection closed after the request frame was
 * written), so it may already have run on the device. Replaying it could repeat
 * the action (issues #6382, #6383), so the outcome is surfaced instead.
 */
export class DaemonToolOutcomeUnknownError extends ActionableError {
  constructor(
    readonly toolName: string,
    cause: unknown,
  ) {
    super(
      `The daemon request for ${toolName} failed after it may have been delivered, so it may ` +
        `or may not have run on the device (${errorMessage(cause)}). It was not retried ` +
        "automatically to avoid repeating a device action; observe the device state before retrying.",
      { cause },
    );
    this.name = "DaemonToolOutcomeUnknownError";
  }
}

/**
 * An observation-only connection (a heartbeat or liveness recovery) found a lifecycle-capable
 * connection attempt in flight and did not join it. Nothing was sent to the daemon, so this is not
 * evidence that the daemon stopped acknowledging heartbeats (#10508).
 */
export class LifecycleConnectionInFlightError extends DaemonUnavailableError {
  constructor() {
    super("Lifecycle-capable daemon connection is in flight; retry observation-only recovery");
    this.name = "LifecycleConnectionInFlightError";
  }
}

function daemonRestartCommand(clientVersion: string, clientBuild?: BuildIdentity): string {
  if (clientBuild?.entryScript) {
    return `${shellQuote(process.execPath)} ${shellQuote(clientBuild.entryScript)} --daemon restart`;
  }
  const installableVersion = releaseVersion(clientVersion);
  return installableVersion.length > 0 && installableVersion !== "unknown"
    ? `bunx @kaeawc/auto-mobile@${installableVersion} --daemon restart`
    : "the same installed auto-mobile package";
}

/**
 * The daemon answered a session's heartbeat with "session not found", and what that means for the
 * session ({@link decideNotFoundAnswer}). Thrown instead of the raw error so the shared reconnect
 * machinery (which resets the one daemon socket and retries "stale session" errors) is not
 * triggered by a per-session answer.
 */
class HeldSessionNotFoundError extends Error {
  constructor(
    readonly sessionUuid: string,
    readonly outcome: NotFoundAnswerOutcome,
  ) {
    // Deliberately not the daemon's "Session not found" wording, which the reconnect machinery matches on.
    super(`The daemon does not know held session ${sessionUuid}`);
    this.name = "HeldSessionNotFoundError";
  }
}

/**
 * Raised before connecting when the running daemon and MCP client package
 * versions differ but the proxy cannot safely reconcile them immediately.
 */
export class DaemonVersionMismatchError extends DaemonUnavailableError {
  readonly clientVersion: string;
  readonly daemonVersion: string;
  readonly reason: VersionMismatchReason;
  readonly retryAfterMs?: number;

  constructor(params: {
    clientVersion: string;
    daemonVersion: string;
    reason: VersionMismatchReason;
    detail: string;
    retryAfterMs?: number;
    clientBuild?: BuildIdentity;
    daemonBuild?: BuildIdentity;
  }) {
    // Use the client's own entrypoint when available. Direct callers that do not
    // provide build identity retain the published-version fallback.
    const installableVersion = releaseVersion(params.clientVersion);
    const restartCommand = daemonRestartCommand(params.clientVersion, params.clientBuild);
    const unresolvedClientVersion =
      installableVersion.trim() === "" || installableVersion === "unknown";
    const retryGuidance = unresolvedClientVersion
      ? " The client package version could not be resolved. Reinstall or repair the AutoMobile client package, then relaunch this MCP client. Restarting the daemon cannot repair missing client version metadata."
      : params.retryAfterMs !== undefined
        ? ` Retry after ${params.retryAfterMs}ms or restart the daemon from this client's build: ${restartCommand}`
        : ` Restart the daemon from this client's build: ${restartCommand}`;
    const sameRelease =
      releaseVersion(params.daemonVersion) === releaseVersion(params.clientVersion) &&
      params.daemonVersion !== params.clientVersion;
    const mismatchMessage =
      sameRelease && params.clientBuild && params.daemonBuild
        ? `AutoMobile daemon build mismatch: daemon build ${describeBuildIdentity(params.daemonBuild)} != ` +
          `client build ${describeBuildIdentity(params.clientBuild)} (${params.detail}).${retryGuidance}`
        : `AutoMobile daemon version mismatch: daemon=${params.daemonVersion}, client=${params.clientVersion} ` +
          `(${params.detail}).${retryGuidance}`;
    super(mismatchMessage);
    this.name = "DaemonVersionMismatchError";
    this.clientVersion = params.clientVersion;
    this.daemonVersion = params.daemonVersion;
    this.reason = params.reason;
    this.retryAfterMs = params.retryAfterMs;
  }
}

/**
 * Raised when the running daemon is a *different build* than this client even
 * though the version strings may be identical (e.g. two checkouts that both
 * report a pre-release version sharing one per-uid socket). Detected via the
 * build-identity content hash rather than the version string.
 */
export class DaemonBuildMismatchError extends DaemonUnavailableError {
  readonly clientBuildId: string;
  readonly daemonBuildId: string;
  readonly clientEntryScript: string;
  readonly daemonEntryScript: string;
  readonly reason: BuildMismatchReason;
  readonly retryAfterMs?: number;

  constructor(params: {
    client: BuildIdentity;
    daemon: BuildIdentity;
    reason: BuildMismatchReason;
    detail: string;
    retryAfterMs?: number;
  }) {
    const retryGuidance =
      params.retryAfterMs !== undefined ? ` Retry after ${params.retryAfterMs}ms.` : "";
    super(
      `AutoMobile daemon build mismatch: the running daemon is a different build than this client ` +
        `(${params.detail}). daemon build=${describeBuildIdentity(params.daemon)}, ` +
        `client build=${describeBuildIdentity(params.client)}.${retryGuidance}`,
    );
    this.name = "DaemonBuildMismatchError";
    this.clientBuildId = params.client.buildId;
    this.daemonBuildId = params.daemon.buildId;
    this.clientEntryScript = params.client.entryScript;
    this.daemonEntryScript = params.daemon.entryScript;
    this.reason = params.reason;
    this.retryAfterMs = params.retryAfterMs;
  }
}

export class DaemonAssetVersionMismatchError extends DaemonUnavailableError {
  readonly clientAssetVersion: string;
  readonly daemonAssetVersion: string;

  constructor(clientAssetVersion: string, daemonAssetVersion: string) {
    super(
      `AutoMobile AUTOMOBILE_VERSION mismatch: caller requested ${clientAssetVersion}, ` +
        `but the shared daemon was started with ${daemonAssetVersion}. Restart the daemon ` +
        `from the caller's environment (for example, run auto-mobile --daemon restart) before reusing it.`,
    );
    this.name = "DaemonAssetVersionMismatchError";
    this.clientAssetVersion = clientAssetVersion;
    this.daemonAssetVersion = daemonAssetVersion;
  }
}

/**
 * Raised after a daemon release proves that this transport's device-session
 * identity is terminal. The transport must never silently resurrect its UUID
 * against another device; an explicit getAndroid/getApple on the same transport
 * acquires a new session (#5689), which is what the message tells the agent (#10702).
 */
export class DaemonBoundSessionExpiredError extends ActionableError {
  readonly sessionUuid: string;
  readonly reason: string;
  readonly release?: SessionReleaseSnapshot;

  constructor(sessionUuid: string, reason: string, release?: SessionReleaseSnapshot) {
    super(
      `Device session ${sessionUuid} expired or was released (${reason}) and cannot be used ` +
        `again. ${DEVICE_SESSION_RECOVERY_PROMPT}`,
    );
    this.name = "DaemonBoundSessionExpiredError";
    this.sessionUuid = sessionUuid;
    this.reason = reason;
    this.release = release;
  }
}

/**
 * Raised after automatic liveness recovery was exhausted for a session this proxy holds (#10053).
 * It is a {@link DaemonBoundSessionExpiredError} so every path that already reports a fenced
 * binding reports it, but it carries the structured `daemon_stalled` / `proxy_stalled` handover
 * the harness acts on instead of the generic ownership-lost recovery.
 */
export class DaemonSessionStalledError extends DaemonBoundSessionExpiredError {
  readonly handover: LivenessHandover;

  constructor(sessionUuid: string, handover: LivenessHandover) {
    super(sessionUuid, handover.code);
    this.message = livenessHandoverMessage(handover);
    this.name = "DaemonSessionStalledError";
    this.handover = handover;
  }

  /** The structured error body for a tool result or MCP error. */
  toPayload(): ReturnType<typeof livenessHandoverPayload> {
    return livenessHandoverPayload(this.handover);
  }
}

/**
 * Raised when a call that does NOT reference a specific device session reaches a
 * connection whose only binding — one MINTED by a device-acquisition RESULT, and
 * therefore never named by the client — has been terminally released. Naming a
 * stale UUID the caller never referenced would misattribute the loss; instead
 * this reports the CURRENT connection state and directs the caller to acquire a
 * fresh session (issue #5689).
 */
export class DaemonConnectionSessionReleasedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(
      `This MCP connection has no active device session (the previous session was released: ${reason}). ` +
        DEVICE_SESSION_RECOVERY_PROMPT,
    );
    this.name = "DaemonConnectionSessionReleasedError";
    this.reason = reason;
  }
}

/** A platform-only control selector matches several sessions this connection holds. */
export class DaemonAmbiguousSessionSelectorError extends Error {
  constructor(
    readonly platform: "android" | "ios",
    readonly candidates: ReadonlyArray<{ sessionUuid: string; deviceId?: string }>,
  ) {
    const sessions = candidates
      .map(({ sessionUuid, deviceId }) =>
        deviceId === undefined ? sessionUuid : `${sessionUuid} (device '${deviceId}')`,
      )
      .join(", ");
    super(
      `Platform '${platform}' alone matches ${candidates.length} device sessions this MCP connection holds: ` +
        `${sessions}. Name one with sessionUuid or deviceId.`,
    );
    this.name = "DaemonAmbiguousSessionSelectorError";
  }
}

/** Raised when a frontend-advertised tool is rejected by the daemon as unknown. */
export class DaemonToolUnavailableError extends Error {
  /** Set when the daemon's availability gate rejected the call, so callers can tell it from skew. */
  readonly code?: typeof DAEMON_TOOL_UNAVAILABLE_CODE;
  readonly toolName: string;
  readonly clientBuildId: string;
  readonly daemonBuildId: string;

  constructor(params: {
    toolName: string;
    client: BuildIdentity;
    daemon: BuildIdentity;
    buildMismatch?: boolean;
    daemonRejection?: string;
    gated?: boolean;
  }) {
    const matchingReason =
      params.client.buildId !== "unknown" &&
      params.client.buildId.length > 0 &&
      params.daemon.buildId !== "unknown" &&
      params.daemon.buildId.length > 0
        ? "The client and daemon build IDs match."
        : params.client.entryScript.length > 0 && params.daemon.entryScript.length > 0
          ? "One or both build IDs are unknown; the entry-script paths match."
          : "Build identity is unavailable on at least one side, so the builds cannot be compared.";
    super(
      params.buildMismatch === false
        ? `Tool "${params.toolName}" is advertised by this AutoMobile client but is unavailable in ` +
            `the connected daemon's current configuration for this session. ` +
            `${params.daemonRejection ? `Daemon rejection: ${params.daemonRejection}. ` : ""}` +
            `client build=${describeBuildIdentity(params.client)}, ` +
            `daemon build=${describeBuildIdentity(params.daemon)}. ${matchingReason}`
        : `Tool "${params.toolName}" is advertised by this AutoMobile client but the connected daemon ` +
            `does not provide it, even after restarting and refreshing the tool list. This usually means a ` +
            `wrong-build daemon is serving this frontend. ` +
            `client build=${describeBuildIdentity(params.client)}, ` +
            `daemon build=${describeBuildIdentity(params.daemon)}. ` +
            `Restart the daemon from this checkout to resolve the skew.` +
            `${params.daemonRejection ? ` Daemon rejection: ${params.daemonRejection}.` : ""}`,
    );
    this.name = "DaemonToolUnavailableError";
    if (params.gated) {
      this.code = DAEMON_TOOL_UNAVAILABLE_CODE;
    }
    this.toolName = params.toolName;
    this.clientBuildId = params.client.buildId;
    this.daemonBuildId = params.daemon.buildId;
  }
}

/** Internal errors shared with the proxy without widening its public error exports. */
export const daemonInternalErrors = {
  ManagedExecutionRegistrationError,
  DaemonPreflightConnectionError,
  HeldSessionNotFoundError,
};
