import { isMcpQueueTimeoutError } from "./McpTimeoutError";
import { errorMessage } from "../utils/describeUnknownError";
import { getRemovedToolHint } from "../models/removedTools";
import { shellQuote } from "../utils/shellQuote";
import {
  DaemonBoundSessionLostError,
  DaemonClient,
  DaemonHandshakeMismatchError,
  DaemonRequestNotDeliveredError,
  DaemonShuttingDownError,
  DaemonUnavailableError,
  type DaemonClientLike,
  type DaemonClientFactory,
} from "./client";
import { DaemonManager, type DaemonManagerLike, type DaemonRestartResult } from "./manager";
import { logger } from "../utils/logger";
import {
  SOCKET_PATH,
  DAEMON_STARTUP_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  DAEMON_VERSION,
  DAEMON_VERSION_RESTART_COOLDOWN_MS,
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM,
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_OWNED_SESSIONS_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM,
  INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM,
  DAEMON_SHUTDOWN_TIMEOUT_MS,
  DAEMON_RESTART_HANDOFF_DELAY_MS,
  DAEMON_RESTART_HANDOFF_TIMEOUT_MS,
  DAEMON_HEARTBEAT_METHOD,
  CLI_SESSION_LIVENESS_POLICY,
  HEARTBEAT_SESSION_LIVENESS_POLICY,
  getCliSessionIdleTimeoutMs,
} from "./constants";
import {
  DAEMON_SESSION_NOT_FOUND_CODE,
  DAEMON_LIVENESS_OWNER_CONFLICT_CODE,
  DAEMON_TOOL_UNAVAILABLE_CODE,
  isGatedToolErrorCode,
  DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE,
  DAEMON_LIVENESS_OWNER_UNOWNED_CODE,
  PROGRESS_NOTIFICATION_METHOD,
  RESOURCE_SUBSCRIBE_METHOD,
  RESOURCE_UNSUBSCRIBE_METHOD,
  type DaemonNotification,
  type DaemonOptions,
  type DaemonStatus,
} from "./types";
import {
  listChangedKindForMethod,
  RESOURCE_UPDATED_NOTIFICATION_METHOD,
  type ListChangedKind,
} from "../server/listChangedBroadcast";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../server/sessionReleaseBroadcast";
import {
  DEVICE_SESSION_RECOVERY_PROMPT,
  declaresDeviceSessionInvalid,
  declaresDeviceSessionSuspect,
  readDeviceSessionSuspectRefusal,
  type DeviceSessionSuspectRefusal,
  getDeviceIdFromResult,
  getDeviceSessionIdFromResult,
  DEVICE_SESSION_ACQUISITION_TOOLS,
  isDeviceSessionAcquisitionTool,
} from "../server/deviceSessionResult";
import {
  toolSelectionProfileUuidFromResponse,
  SET_TOOL_ENABLED_TOOL_NAME,
} from "../features/toolSelection/toolSelectionControl";
import { OUTPUT_REDUCTION_FLAG_SPECS } from "../utils/outputReductionFlags";
import { compareStrictNumericVersions } from "../server/deviceMatcher";
import { releaseVersion } from "../utils/mcpVersion";
import { defaultTimer, type Timer } from "../utils/SystemTimer";
import { defaultIdGenerator, type IdGenerator } from "../utils/IdGenerator";
import { isExplicitPin, resolveAssetVersion, resolvePinnedVersion } from "../constants/release";
import { SingleFlightInterval } from "./SingleFlightInterval";
import { getDefaultSessionHeartbeatTimeoutMs, type SessionReleaseSnapshot } from "./sessionManager";
import { raceWithDeadline } from "../utils/raceWithDeadline";
import {
  type BuildIdentity,
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  describeBuildIdentity,
  getCurrentBuildIdentity,
} from "./buildIdentity";
import { ActionableError, toActionableError } from "../models";
import { DeviceControlTransportError, isReplaySafeToolName } from "./deviceControlTransportFailure";
import { McpOverloadError, McpTimeoutError } from "./McpTimeoutError";
import {
  getConnectedStaticToolDefinitions,
  getStaticToolDefinitions,
} from "./staticToolDefinitions";
import { DaemonRestartDeferredError } from "./daemonRestartAdmission";
import { isRecoverableDaemonReleaseReason } from "../db/deviceSessionRepository";
import { daemonProcessOptions, daemonReuseOptions } from "./daemonOptionScopes";
import {
  DAEMON_STALLED_CODE,
  LivenessRecovery,
  PROXY_STALLED_CODE,
  TickLatenessClock,
  daemonLifecycleAllowed,
  runWithoutDaemonLifecycle,
  livenessHandoverMessage,
  livenessHandoverPayload,
  livenessRecoveryCallWaitMs,
  ownershipConflictLeashMs,
  type LivenessHandover,
  type RecoveryAttemptOutcome,
} from "./proxyLivenessRecovery";

export { DaemonRestartDeferredError } from "./daemonRestartAdmission";

function isPermanentResourceSubscriptionRejection(error: unknown): boolean {
  if (error instanceof McpTimeoutError || error instanceof DaemonUnavailableError) {
    return false;
  }
  if (error !== null && typeof error === "object" && "code" in error && error.code !== undefined) {
    return error.code === -32601 || error.code === -32602;
  }
  // These daemon responses currently carry only text, not a structured rejection code.
  const message = errorMessage(error);
  return (
    message.startsWith("Unsupported daemon method: resources/subscribe") ||
    message === "Resource subscription requires params.uri"
  );
}
export type VersionMismatchReason =
  | "autoStartDisabled"
  | "cooldown"
  | "daemonNewer"
  | "nonNumeric"
  | "restartMismatch";

export type BuildMismatchReason = "autoStartDisabled" | "cooldown" | "restartMismatch";

const DAEMON_MCP_HEARTBEAT_INTERVAL_MS = 2_000;
const CLI_SESSION_FINALIZATION_TIMEOUT_MS = 2_000;
const COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;
// These inventory tools never operate a device or mint a device session. They
// normally retain a live binding's policy, but after that binding is terminally
// released they must be able to discover the stable target for an explicit
// getAndroid/getApple reacquisition (#7144).
const SESSIONLESS_DEVICE_DISCOVERY_TOOLS = ["listDevices", "listDeviceImages"] as const;

export function isDeviceInventoryTool(name: unknown): boolean {
  return (
    typeof name === "string" &&
    (SESSIONLESS_DEVICE_DISCOVERY_TOOLS as readonly string[]).includes(name)
  );
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

/**
 * Whether a call the daemon refused as suspect may be forwarded once more after recovery.
 *
 * Every tool call reaches a suspect check at session admission, before its handler runs:
 * `admitIssuedSessionForAutomation` in `src/server/index.ts` (plain tools) or
 * `src/server/toolRegistry.ts` (device tools, whose earlier enforcement returns at once when a
 * sessionUuid is given). Plan and critical-section steps wrap a nested refusal in their own error,
 * so the suspect code at the top of a result always means "nothing ran". The exceptions are tools
 * whose handler binds or reuses a device session through `DevicePool.bindOrReuseDeviceSession`,
 * which can reach the same check after starting or binding a device: device acquisition and
 * `setActiveDevice`. Those are never retried, nor is a refusal for a session other than the one
 * forwarded (a label-derived session).
 */
function isSuspectRefusalRetryable(
  name: string,
  forwardedSessionUuid: string,
  refusal: DeviceSessionSuspectRefusal,
): boolean {
  return (
    refusal.sessionUuid === forwardedSessionUuid &&
    !isDeviceSessionAcquisitionTool(name) &&
    name !== "setActiveDevice"
  );
}

/** A forwarded tool call's result, with the suspect refusal the proxy may retry it after. */
interface ForwardedToolCall {
  result: any;
  retryableSuspectRefusal?: DeviceSessionSuspectRefusal;
}

/** The tool name when replaying it could repeat a device action, else undefined. */
function nonIdempotentToolName(name: string): string | undefined {
  return isReplaySafeToolName(name) || isDeviceInventoryTool(name) ? undefined : name;
}

/** Failures that give no evidence the forwarded session is still live and admitted. */
function isUnprovenSessionAdmissionError(error: unknown): boolean {
  return (
    error instanceof DaemonBoundSessionExpiredError ||
    error instanceof DaemonBoundSessionLostError ||
    error instanceof DaemonToolOutcomeUnknownError
  );
}

async function runPreflightTransport<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      throw new DaemonPreflightConnectionError(error);
    }
    throw error;
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

function startupOptionRecoveryGuidance(): string {
  return (
    "Close and relaunch this configured MCP client once so it owns the next bounded " +
    "reconciliation attempt; do not delete daemon control files manually."
  );
}

function isFreshSessionScreenshotUri(uri: string, sessionUuid: string): boolean {
  return uri === `automobile:device-session/${sessionUuid}/screenshot`;
}

// A tool-output artifact read (`automobile:tool-output/<id>`) is a plain host
// file read routed through the session-independent resource registry — no device
// access and no session data. So unlike the fresh-screenshot exemption it is not
// scoped to any session, and it must stay retrievable after a terminal release
// (e.g. executePlan auto-releases its bound session, then emits an artifact
// resourceUri that would otherwise be fenced). Kept in lockstep with the
// `automobile:tool-output/` prefix in src/server/toolOutputResources.ts.
function isToolOutputResourceUri(uri: string): boolean {
  return uri.startsWith("automobile:tool-output/");
}

// The session UUID embedded in a session-scoped observation resource URI, or
// undefined for any other URI. Kept in lockstep with RESOURCE_URIS in
// src/server/observationResources.ts.
function sessionScopedObservationUriSessionUuid(uri: string): string | undefined {
  const match = uri.match(
    /^automobile:(?:observation\/session\/([^/]+)\/latest(?:\/screenshot)?|device-session\/([^/]+)\/screenshot)$/,
  );
  return match?.[1] ?? match?.[2];
}

function heartbeatIntervalMs(config: DaemonMcpProxyConfig): number {
  const configuredTimeout = config.heartbeatTimeoutMs;
  const configuredInterval = config.heartbeatIntervalMs;
  if (
    configuredTimeout !== undefined &&
    (!Number.isFinite(configuredTimeout) || configuredTimeout <= 0)
  ) {
    throw new Error("heartbeat timeout must be a positive finite number");
  }
  const interval =
    configuredInterval ??
    (configuredTimeout === undefined
      ? DAEMON_MCP_HEARTBEAT_INTERVAL_MS
      : Math.max(1, Math.floor(configuredTimeout / 2)));
  if (!Number.isFinite(interval) || interval <= 0) {
    throw new Error("heartbeat interval must be a positive finite number");
  }
  return Math.max(1, interval);
}

function isLivenessOwnerConflictError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === DAEMON_LIVENESS_OWNER_CONFLICT_CODE
  );
}

/** The daemon answered that this token no longer owns liveness (#10050, #10260). */
function isLivenessOwnershipLostError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE ||
      error.code === DAEMON_LIVENESS_OWNER_UNOWNED_CODE)
  );
}

/**
 * The daemon answered a held session's heartbeat with "session not found". Thrown instead of the
 * raw error so the shared reconnect machinery (which resets the one daemon socket and retries
 * "stale session" errors) is not triggered by a per-session answer.
 */
class HeldSessionNotFoundError extends Error {
  constructor(readonly sessionUuid: string) {
    // Deliberately not the daemon's "Session not found" wording, which the reconnect machinery matches on.
    super(`The daemon does not know held session ${sessionUuid}`);
    this.name = "HeldSessionNotFoundError";
  }
}

/** The heartbeat request timeout: how long a heartbeat is given before it counts as unanswered. */
function heartbeatRequestTimeoutMs(leaseMs: number, intervalMs: number): number {
  return Math.max(1, Math.min(Math.floor(leaseMs / 2), intervalMs * 2));
}

/** The harness-supplied stable owner token when given, otherwise a per-process one (#10050). */
function resolveLivenessOwnerToken(config: DaemonMcpProxyConfig): string {
  const suppliedToken = config.livenessOwnerToken?.trim();
  return suppliedToken ? suppliedToken : (config.idGenerator ?? defaultIdGenerator).next();
}

/** The heartbeat lease the proxy believes the daemon enforces on the sessions it holds. */
function heartbeatLeashMs(config: DaemonMcpProxyConfig): number {
  return config.heartbeatTimeoutMs ?? getDefaultSessionHeartbeatTimeoutMs();
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
 * identity is terminal. A fresh transport may create a new session; this bound
 * transport must never silently resurrect its UUID against another device.
 */
export class DaemonBoundSessionExpiredError extends ActionableError {
  readonly sessionUuid: string;
  readonly reason: string;
  readonly release?: SessionReleaseSnapshot;

  constructor(sessionUuid: string, reason: string, release?: SessionReleaseSnapshot) {
    super(
      `Device session ${sessionUuid} expired or was released (${reason}). ` +
        "This MCP transport cannot create a replacement session; start a new transport.",
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

/**
 * Callback for a relayed `notifications/progress` tick (issue #6205), mirroring
 * `ProgressCallback` in `src/server/toolRegistry.ts` without importing the
 * server's tool-registry module from the daemon layer.
 */
export type DaemonProxyProgressCallback = (
  progress: number,
  total?: number,
  message?: string,
) => void;

/**
 * Configuration for the DaemonMcpProxy
 */
export interface DaemonMcpProxyConfig {
  /** Whether to automatically start the daemon if not running */
  autoStartDaemon?: boolean;
  /** Socket path for daemon communication */
  socketPath?: string;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
  /** Factory for creating daemon clients (for testing) */
  clientFactory?: DaemonClientFactory;
  /** Socket-owner identity probe; custom client factories inject this separately. */
  daemonStatusProbe?: () => Promise<DaemonStatus>;
  /** Observation-only socket availability probe; injectable for deterministic tests. */
  daemonAvailabilityProbe?: (socketPath: string) => Promise<boolean>;
  /** Custom daemon manager (for testing) */
  daemonManager?: DaemonManagerLike;
  /** Requested daemon-global options plus connection presentation options. */
  daemonOptions?: DaemonOptions;
  /** Timer for restart cooldown checks and bound-session heartbeats. */
  timer?: Timer;
  /** Daemon session heartbeat timeout used to derive a safe cadence when unset. */
  heartbeatTimeoutMs?: number;
  /** Explicit bound-session heartbeat cadence; defaults to half the timeout or 2s. */
  heartbeatIntervalMs?: number;
  /** This client's build identity (for testing; defaults to the current process build) */
  buildIdentity?: BuildIdentity;
  /** This client's version for the daemon version gate (defaults to DAEMON_VERSION; injectable for testing) */
  clientVersion?: string;
  /** Existing device-pool session bound before the first discovery request. */
  initialSessionUuid?: string;
  /**
   * Harness-supplied stable liveness-owner token (`--liveness-owner-token`). A
   * proxy restarted with the same token resumes the sessions it owned instead of
   * being locked out by the daemon's live-owner rule (#10050). When absent the
   * proxy mints a per-process token from `idGenerator`.
   */
  livenessOwnerToken?: string;
  /** Mints the per-process liveness-owner token when none is supplied (injectable for tests). */
  idGenerator?: IdGenerator;
  /**
   * Supplies the static tool surface served by `listAdvertisedTools()` before a
   * daemon connection exists (issue #5879). Defaults to the committed
   * `schemas/tool-definitions.json`; injectable for testing.
   */
  staticToolDefinitionsProvider?: () => ProxiedToolDefinition[];
  /**
   * Supplies static schemas eligible to supplement a connected daemon's live
   * list. Defaults to the static catalog without plan-only definitions.
   */
  connectedStaticToolDefinitionsProvider?: (
    daemonOptions?: DaemonOptions,
  ) => ProxiedToolDefinition[];
  /**
   * Private live-acceptance configuration. It is set only while constructing
   * the dedicated harness proxy; MCP tool callers cannot set it.
   *
   * Its signed internal arguments control discovery presentation where needed
   * and retain structured tool payloads for the acceptance contract.
   */
  acceptanceDiscovery?: {
    order: "forward" | "reverse";
    capability: string;
  };
}

/**
 * Tool definition from daemon
 */
export interface ProxiedToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  // Passed through verbatim from the daemon (live path) or the committed static
  // surface (cold path) — e.g. the MCP Apps UI pointer `_meta.ui.resourceUri`
  // (issue #4669). Non-Apps hosts ignore it.
  _meta?: Record<string, unknown>;
}

function connectedStaticToolDefinitionsProvider(
  config: DaemonMcpProxyConfig,
): (daemonOptions?: DaemonOptions) => ProxiedToolDefinition[] {
  return (
    config.connectedStaticToolDefinitionsProvider ??
    config.staticToolDefinitionsProvider ??
    getConnectedStaticToolDefinitions
  );
}

function daemonAvailabilityProbe(
  config: DaemonMcpProxyConfig,
): (socketPath: string) => Promise<boolean> {
  return config.daemonAvailabilityProbe ?? ((socketPath) => DaemonClient.isAvailable(socketPath));
}

/**
 * Resource definition from daemon
 */
export interface ProxiedResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * Resource template definition from daemon
 */
export interface ProxiedResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
}

/**
 * The daemon startup options that change its observable MCP behavior and so must
 * match before a running daemon can be reused: `debug`, `embeddedSdk`, `networkMockable`,
 * every process-global feature-flag CLI override, marker-based eventAll promotion config,
 * plus every process-global output-reduction flag. A
 * same-build MCP client that requests one of these against an already-running
 * daemon started without it (or vice versa) would otherwise silently get the
 * wrong tool-output or text-input behavior until a manual restart. `debug`, `embeddedSdk`,
 * and `networkMockable`
 * additionally gate whole tool families out of the registry, so reusing a daemon
 * that lacks the requested flag makes those tools unreachable (issue #4247). The
 * output-reduction fields are derived from `OUTPUT_REDUCTION_FLAG_SPECS` (whose
 * `field` names map 1:1 to `DaemonOptions`) so a new flag is covered
 * automatically.
 */
export const REUSE_CRITICAL_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "debug",
  "debugPerf",
  "embeddedSdk",
  "networkMockable",
  "noUiPerfMode",
  "memPerfAudit",
  "accessibilityAudit",
  "predictiveUi",
  "rawElementSearch",
  "mcpRecording",
  "noNavigationScreenshots",
  ...OUTPUT_REDUCTION_FLAG_SPECS.filter(
    (spec) =>
      spec.field !== "toolResultsNoStructuredContent" && spec.field !== "actionsCompactMetadata",
  ).map((spec) => spec.field),
];

const REUSE_CRITICAL_STRING_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "toolOutputsDir",
  "accessibilityLevel",
  "accessibilityFailureMode",
  "accessibilityMinSeverity",
];

const REUSE_CRITICAL_NUMBER_OPTION_KEYS: (keyof DaemonOptions)[] = ["runnerReadinessTimeoutMs"];

/** Every startup option inspected by startupOptionDeficits(). */
export const STARTUP_OPTION_DEFICIT_KEYS: readonly (keyof DaemonOptions)[] = [
  ...REUSE_CRITICAL_OPTION_KEYS,
  ...REUSE_CRITICAL_STRING_OPTION_KEYS,
  ...REUSE_CRITICAL_NUMBER_OPTION_KEYS,
  "accessibilityUseBaseline",
  "actionsCompactMetadata",
  "eventAllMarkers",
];

/** The value of a startup option when it is a string, else undefined. */
function stringOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions,
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions,
): number | undefined {
  const value = options?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions,
): readonly string[] | undefined {
  const value = options?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requestedOptionDeficits<T>(
  keys: readonly (keyof DaemonOptions)[],
  requested: DaemonOptions | undefined,
  running: DaemonOptions | undefined,
  readRequested: (options: DaemonOptions | undefined, key: keyof DaemonOptions) => T | undefined,
  readRunning: (options: DaemonOptions | undefined, key: keyof DaemonOptions) => T,
  equals: (requestedValue: T, runningValue: T) => boolean = (left, right) => left === right,
): string[] {
  return keys.flatMap((key) => {
    const requestedValue = readRequested(requested, key);
    if (requestedValue === undefined) {
      return [];
    }
    const runningValue = readRunning(running, key);
    return equals(requestedValue, runningValue)
      ? []
      : [
          `${key} (requested=${JSON.stringify(requestedValue)}, running=${JSON.stringify(runningValue)})`,
        ];
  });
}

/**
 * Reuse-critical startup options the connecting client *explicitly requests*
 * that the running daemon lacks. Reconciliation is **one-directional** (issue
 * #3846): a client that does not ask for a flag has no opinion on it, so a flag
 * the daemon already has is never reported as a deficit just because a
 * particular caller (e.g. a bare short-lived CLI client) didn't request it.
 * Compact metadata compares explicit on/off; an unrecorded running value defaults on.
 * Other booleans are compared strictly (`=== true`), so `undefined` and `false` both
 * read as "no opinion"; strings and marker arrays count only when the client
 * supplies one that differs from the daemon's. Connection presentation options
 * are intentionally absent from this comparison.
 * Returns a human-readable list (empty when the daemon already satisfies every
 * requested flag) for logging and error messages.
 */
export function startupOptionDeficits(
  requested: DaemonOptions | undefined,
  running: DaemonOptions | undefined,
): string[] {
  return [
    ...requestedOptionDeficits(
      REUSE_CRITICAL_OPTION_KEYS,
      requested,
      running,
      (options, key) => (options?.[key] === true ? true : undefined),
      (options, key) => options?.[key] === true,
    ),
    ...requestedOptionDeficits(
      ["actionsCompactMetadata"],
      requested,
      running,
      (options) => options?.actionsCompactMetadata,
      (options) => options?.actionsCompactMetadata ?? true,
    ),
    ...requestedOptionDeficits(
      REUSE_CRITICAL_STRING_OPTION_KEYS,
      requested,
      running,
      stringOption,
      (options, key) => stringOption(options, key) ?? "unset",
    ),
    ...requestedOptionDeficits(
      REUSE_CRITICAL_NUMBER_OPTION_KEYS,
      requested,
      running,
      numberOption,
      (options, key) => numberOption(options, key) ?? Number.NaN,
    ),
    ...requestedOptionDeficits(
      ["accessibilityUseBaseline"],
      requested,
      running,
      (options) =>
        options?.accessibilityAudit === true
          ? options.accessibilityUseBaseline === true
          : undefined,
      (options) => options?.accessibilityUseBaseline === true,
    ),
    ...requestedOptionDeficits(
      ["eventAllMarkers"],
      requested,
      running,
      (options, key) => stringArrayOption(options, key),
      (options, key) => stringArrayOption(options, key) ?? [],
      arraysEqual,
    ),
  ];
}

/**
 * Options to launch a replacement daemon with when a restart is unavoidable
 * (version/build skew, or a genuine startup-option deficit). Preserves the
 * *running* daemon's existing options as the base and overlays the connecting
 * client's requested options, so a restart triggered for any reason can never
 * silently strip a flag the daemon was already launched with (issue #3846) —
 * it only ever adds flags the client explicitly asks for. Boolean CLI options
 * are one-directional: `false` means the caller has no opinion, so every
 * active boolean on the running daemon is force-preserved. Compact metadata
 * instead preserves the running value only when the client has no preference.
 */
export function mergeDaemonOptions(
  running: DaemonOptions | undefined,
  requested: DaemonOptions | undefined,
): DaemonOptions {
  const runningOptions = daemonReuseOptions(running);
  const requestedOptions = daemonReuseOptions(requested);
  const merged: DaemonOptions = { ...runningOptions, ...requestedOptions };
  const mergedRecord = merged as Record<string, unknown>;
  for (const [key, value] of Object.entries(runningOptions)) {
    if (value === true) {
      mergedRecord[key] = true;
    }
  }
  merged.actionsCompactMetadata =
    requestedOptions.actionsCompactMetadata ?? runningOptions.actionsCompactMetadata;
  if (requested?.accessibilityAudit === true) {
    merged.accessibilityUseBaseline = requested.accessibilityUseBaseline === true;
  }
  for (const key of REUSE_CRITICAL_STRING_OPTION_KEYS) {
    const runningString = stringOption(running, key);
    if (stringOption(requested, key) === undefined && runningString !== undefined) {
      mergedRecord[key] = runningString;
    }
  }
  for (const key of REUSE_CRITICAL_NUMBER_OPTION_KEYS) {
    const runningNumber = numberOption(running, key);
    if (numberOption(requested, key) === undefined && runningNumber !== undefined) {
      mergedRecord[key] = runningNumber;
    }
  }
  return merged;
}

/**
 * DaemonMcpProxy - Proxy layer for MCP server to communicate with daemon
 *
 * This class handles:
 * - Auto-connecting to an existing daemon
 * - Auto-starting a daemon if one isn't running
 * - Forwarding MCP tool calls to the daemon
 * - Forwarding MCP resource requests to the daemon
 * - Caching tool/resource definitions from daemon
 */
export class DaemonMcpProxy {
  private client: DaemonClientLike | null = null;
  private config: DaemonMcpProxyConfig;
  private daemonManager: DaemonManagerLike;
  private clientFactory: DaemonClientFactory;
  private readonly daemonStatusProbe?: () => Promise<DaemonStatus>;
  private readonly daemonAvailabilityProbe: (socketPath: string) => Promise<boolean>;
  private reconciliationSnapshot?: Promise<DaemonStatus>;
  // Connection-scoped: tools/list_changed invalidates status, but does not replace its daemon.
  private structuredSessionNotFound = false;
  private readonly timer: Timer;
  private readonly heartbeatKeeper: SingleFlightInterval;
  private readonly heartbeatLeashMs: number;
  private readonly heartbeatIntervalMs: number;
  /**
   * Whether the recurring bound-session heartbeat keeper has been started for the
   * current binding. Gates the awaited establishment heartbeat (issue #5637) to
   * the FIRST connection only: once the keeper is running it owns every
   * subsequent tick, so a later reconnect must not send an extra, un-coalesced
   * heartbeat.
   */
  private heartbeatKeeperStarted = false;
  /**
   * Whether this connection already declared its bound session CLI-owned
   * (issue #6870 review). Once declared, this proxy's remaining heartbeats must
   * keep carrying the CLI marker: an ordinary heartbeat now restores the strict
   * contract on the daemon, and a keeper tick racing process exit would undo the
   * declaration the invocation just made.
   */
  private cliSessionLivenessDeclared = false;
  /**
   * Whether this binding has sent its one ownership-claim heartbeat. Marked
   * before awaiting the request, because the daemon may apply it even when the
   * response is lost; reconnects must then verify the same token, not reclaim.
   */
  private livenessOwnershipClaimSent = false;
  /**
   * Device sessions this proxy still holds besides its latest binding, each with
   * whether its ownership claim has been delivered (#9335). `boundSessionUuid`
   * only tracks the LATEST binding, so acquiring or naming a second session moves
   * it off the first, which still depends on this proxy for liveness. Every entry
   * is heartbeated on the keeper's cadence under the same owner token; an entry
   * leaves on release, fencing, confirmed loss and close.
   */
  private readonly otherHeldSessions = new Map<
    string,
    {
      claimSent: boolean;
      /**
       * Proxy-clock time a tool call last bound this session (#10657). A held session nothing
       * has named for {@link DAEMON_BOUND_SESSION_REPLAY_TTL_MS} is abandoned and evicted, so a
       * conversation that moved to another device stops pinning the old one.
       */
      lastUsedAt: number;
      /** When the daemon first refused this session's claim as a live-owner conflict (#10050). */
      conflictSince?: number;
    }
  >();
  /** Supersession is informational; report it at most once per proxy instance. */
  private livenessSupersessionLogged = false;
  /** Sessions whose live-owner conflict was already reported, so each tick does not repeat it. */
  private readonly livenessConflictLogged = new Set<string>();
  /** How long a refused claim keeps retrying: the other owner's lease plus its grace (#10053). */
  private readonly ownershipConflictLeashMs: number;
  /**
   * When the daemon first refused the latest binding's claim as a live-owner conflict (#10664).
   * Keyed by UUID so a binding change or a successful heartbeat starts a fresh leash.
   */
  private latestBindingConflict: { sessionUuid: string; since: number } | undefined;
  /** Bounded per-session recovery when heartbeat acknowledgements stop (#10053). */
  private readonly livenessRecovery: LivenessRecovery;
  /** The call-wait bound of the current stretch of liveness recovery (#10508). */
  private livenessRecoveryCallWait: { episode: number; deadline: number } | undefined;
  /** Detects this proxy's own tick firing later than the lease allows. */
  private readonly tickLateness: TickLatenessClock;
  /** Proxy-clock time of each held session's last acknowledged heartbeat. */
  private readonly livenessAcks = new Map<string, number>();
  /** Device each held session runs on, learned from acquisition results and explicit calls. */
  private readonly sessionDeviceIds = new Map<string, string>();
  /**
   * Handovers awaiting delivery, per affected session. The first tool call that names the session
   * (or reaches it implicitly) returns the structured error; naming it again attempts an
   * observation-only resume until a definitive daemon answer ends the handover.
   */
  private readonly stallHandovers = new Map<
    string,
    { handover: LivenessHandover; delivered: boolean }
  >();
  /** Definitively lost sessions awaiting one tool-call delivery; these do not fence lifecycle. */
  private readonly pendingSessionLosses = new Map<string, LivenessHandover>();
  private readonly livenessHandoverListeners = new Set<(handover: LivenessHandover) => void>();
  /** Tool calls currently awaiting an answer on each daemon connection. */
  private readonly toolCallsInFlight = new WeakMap<DaemonClientLike, number>();
  /** Connections a liveness attempt saw fail at the transport level: dead, with nothing to lose. */
  private readonly deadSocketClients = new WeakSet<DaemonClientLike>();
  /** Stable for this proxy instance, including all transport reconnects. */
  private readonly livenessOwnerToken: string;
  private readonly buildIdentity: BuildIdentity;
  private readonly clientVersion: string;
  private readonly clientAssetVersion: string | null;
  private connecting: Promise<void> | null = null;
  private connectingAllowsLifecycle = false;
  private connectionCloseReject: ((reason?: unknown) => void) | null = null;
  /**
   * A `daemon-shutdown` release arrives before the old daemon closes its socket.
   * Calls admitted for replacement acquisition wait on this peer-close barrier
   * instead of reconnecting to the still-reachable but quiesced incarnation.
   */
  private daemonShutdownDisconnect: Promise<void> | null = null;
  private resolveDaemonShutdownDisconnect: (() => void) | null = null;
  private connected: boolean = false;
  private closing: boolean = false;
  // The daemon clears socket-local state when its RPC connection drops. Keep this
  // proxy's successful explicit binding so subsequent sessionless calls can seed
  // a replacement socket without sharing the binding with other proxies.
  private boundSessionUuid: string | undefined;
  // When the binding above was last set/refreshed, on the injected clock. Once
  // the daemon's session idle window elapses with no explicit-sessionUuid call
  // refreshing it, the remembered UUID is treated as retired so a sessionless
  // call is not rewritten to a released session (issue #4610).
  private boundSessionUuidAt: number | undefined;
  // Whether the current binding was minted by a device-acquisition RESULT
  // (getAndroid/getApple/startDevice), i.e. never named by the client, versus
  // client-declared (an explicit `sessionUuid` arg, or a startup
  // `initialSessionUuid`). Governs how a fenced sessionless call is reported: a
  // client-declared binding keeps the ownership-lost-for-UUID error, while a
  // result-minted one reports the connection state instead of a stale UUID the
  // caller never referenced (issue #5689).
  private boundSessionFromResultMint = false;
  // Every device session this connection has bound over its lifetime and not yet
  // seen released. `boundSessionUuid` only tracks the LATEST binding, so acquiring
  // a second device (e.g. getApple after getAndroid) moves it off the first
  // session. A fresh-screenshot resource read names its session in the URI, and it
  // must route to that owning session — not the latest binding — or the daemon
  // seeds the loopback with the wrong session and denies the just-established
  // owner with SCREENSHOT_ACCESS_DENIED (issue #5663). Membership here is what
  // authorizes owner-routing; a session this connection never bound is absent, so
  // a foreign read still forwards this connection's own binding and stays denied.
  private readonly ownedDeviceSessions = new Set<string>();
  /**
   * Sessions this proxy may claim liveness ownership of and heartbeat (#10664): ones it minted
   * from an acquisition RESULT, plus the startup `initialSessionUuid`. A session only NAMED in a
   * tool call's `sessionUuid` arg is forwarded and bound for routing, but never claimed or
   * heartbeated, so a proxy cannot inherit a session another proxy (or a CLI keeper) owns once
   * that owner's lease lapses. The other owner keeps it alive or the daemon reaps it.
   */
  private readonly claimableSessions = new Set<string>();
  // Once the daemon confirms this transport's bound session is gone, preserve
  // that terminal identity instead of clearing it and allowing the same UUID to
  // acquire another device. `fromResultMint` records the binding's provenance at
  // fence time (see boundSessionFromResultMint).
  private terminalBoundSession:
    | {
        sessionUuid: string;
        reason: string;
        fromResultMint: boolean;
        release?: SessionReleaseSnapshot;
      }
    | undefined;
  /** A recoverable daemon release needs a replacement transport, not a UUID fence. */
  private recoverableBoundSessionHandoff: string | undefined;
  // Startup bindings remain authoritative until the daemon signals release.
  // Replay expiration only protects bindings inferred from ordinary calls.
  private initialSessionBindingConfigured = false;
  // A connection-level tool-selection profile is not a daemon device session. It
  // survives executePlan's device-session release and is forwarded through the
  // socket only when no explicit/remembered routing session is in use.
  private toolSelectionProfileUuid: string | undefined;
  // Monotonic release-epoch counter, bumped every time the daemon signals that a
  // session was released (via handleDaemonNotification). `releasedSessionEpochs`
  // records, per released UUID, the epoch at which it was last released. A
  // callTool captures the epoch at forward time; on completion the post-call
  // remember/refresh asks "was the SPECIFIC UUID I forwarded released at a later
  // epoch?" and, if so, declines to resurrect it. Scoping the guard to the
  // forwarded UUID (issue #4655) — rather than a single global generation bumped
  // by ANY binding change (issue #4611's first cut) — means the release of an
  // UNRELATED session mid-call no longer blocks remembering the session THIS call
  // actually forwarded, while a release of the forwarded UUID still preserves.
  private releaseEpoch: number = 0;
  private readonly releasedSessionEpochs = new Map<string, number>();
  private readonly releasedSessionReasons = new Map<string, string>();
  private readonly activeReleaseEpochReferences = new Map<string, number>();
  private readonly activeAcquisitionReleaseEpochs = new Map<number, number>();
  // Monotonic counter bumped whenever a daemon push invalidates a discovery cache
  // or the session binding mid-flight (list_changed nulls a cache; a bound-session
  // release changes the session scope). A `tools/list` / `resources/list` captures
  // this at forward time and, if it has advanced by completion, declines to store
  // the now-stale response into the cache the invalidation just cleared — the next
  // discovery refetches under the current scope (issue #4655).
  private discoveryEpoch: number = 0;

  // Supplies the static tool surface for listAdvertisedTools() before a daemon
  // connection exists (issue #5879).
  private readonly staticToolDefinitionsProvider: () => ProxiedToolDefinition[];
  private readonly connectedStaticToolDefinitionsProvider: (
    daemonOptions?: DaemonOptions,
  ) => ProxiedToolDefinition[];
  // Set when listAdvertisedTools() served the static surface without a live
  // connection. On the next successful connect the proxy emits a tools
  // list_changed so the client re-fetches the accurate (session-scoped) list.
  private servedStaticToolList = false;
  // Set when listAdvertisedResources()/listAdvertisedResourceTemplates() served
  // a cold (empty/cached) roster without a live connection. On the next connect
  // the proxy emits a resources list_changed so the client re-fetches the real
  // resources (issue #5879 review — a host that enumerates resources on init
  // must not block on a wedged daemon before the first tool call).
  private servedStaticResourceList = false;
  private backgroundConnectRetry: NodeJS.Timeout | null = null;
  private backgroundConnectRetryAttempt = 0;
  private connectedFallbackReconcile: NodeJS.Timeout | null = null;
  private connectedFallbackReconcileAttempt = 0;

  // Cached definitions from daemon
  private cachedTools: ProxiedToolDefinition[] | null = null;
  private cachedResources: ProxiedResourceDefinition[] | null = null;
  private cachedResourceTemplates: ProxiedResourceTemplate[] | null = null;

  private readonly resourceSubscriptions = new Set<string>();
  private readonly resourceUpdatedListeners = new Set<(uri: string) => void>();
  private resourceSubscriptionSync: Promise<void> = Promise.resolve();
  // Listeners for daemon-forwarded list-changed notifications (issue #3223),
  // fired after the matching cache is invalidated so a re-fetch is never stale.
  private readonly listChangedListeners = new Set<(kind: ListChangedKind) => void>();
  // A token can be reused by concurrent callers, and a new connection can
  // reuse a request id. Scope listeners to the client connection, then match
  // both the daemon request id and echoed caller token.
  private readonly progressListeners = new Map<
    DaemonClientLike,
    Map<string, { progressToken: string | number; listener: DaemonProxyProgressCallback }>
  >();
  // Releases this proxy's handler on the current client. Needed because a
  // clientFactory may return a shared/reused client (test fakes do); without it
  // every reconnect would stack another handler on that client.
  private notificationUnsubscribe: (() => void) | null = null;
  // A daemon can close an idle socket without any request failing. Keep the
  // proxy's connection state synchronized with that passive transport loss.
  private connectionClosedUnsubscribe: (() => void) | null = null;

  constructor(config: DaemonMcpProxyConfig = {}) {
    this.config = {
      autoStartDaemon: true,
      socketPath: SOCKET_PATH,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      ...config,
    };
    this.daemonManager = config.daemonManager ?? new DaemonManager();
    this.clientFactory =
      config.clientFactory ??
      (() => new DaemonClient(this.config.socketPath, this.config.connectionTimeoutMs));
    this.daemonStatusProbe = this.createStatusProbe(config);
    this.daemonAvailabilityProbe = daemonAvailabilityProbe(config);
    this.timer = config.timer ?? defaultTimer;
    this.heartbeatLeashMs = heartbeatLeashMs(config);
    this.heartbeatIntervalMs = heartbeatIntervalMs(config);
    this.ownershipConflictLeashMs = ownershipConflictLeashMs(
      this.heartbeatLeashMs,
      this.heartbeatIntervalMs,
    );
    this.tickLateness = new TickLatenessClock(this.heartbeatIntervalMs);
    this.livenessRecovery = this.createLivenessRecovery();
    this.livenessOwnerToken = resolveLivenessOwnerToken(config);
    this.heartbeatKeeper = new SingleFlightInterval(
      this.timer,
      this.heartbeatIntervalMs,
      () => this.runBoundSessionHeartbeatTick(),
      {
        stopTimeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS,
        onError: (error) => {
          logger.warn(`[DaemonMcpProxy] Bound-session heartbeat failed: ${error}`);
        },
      },
    );
    if (
      typeof config.initialSessionUuid === "string" &&
      config.initialSessionUuid.trim().length > 0
    ) {
      this.boundSessionUuid = config.initialSessionUuid.trim();
      this.boundSessionUuidAt = this.timer.now();
      this.initialSessionBindingConfigured = true;
      this.ownedDeviceSessions.add(this.boundSessionUuid);
      this.claimableSessions.add(this.boundSessionUuid);
    }
    this.staticToolDefinitionsProvider =
      config.staticToolDefinitionsProvider ?? getStaticToolDefinitions;
    this.connectedStaticToolDefinitionsProvider = connectedStaticToolDefinitionsProvider(config);
    this.buildIdentity = config.buildIdentity ?? getCurrentBuildIdentity();
    this.clientVersion = config.clientVersion ?? DAEMON_VERSION;
    this.clientAssetVersion = isExplicitPin() ? resolveAssetVersion(resolvePinnedVersion()) : null;
  }

  /** Test-only seam for checking active progress listener cleanup. */
  getProgressListenerCountForTesting(): number {
    return this.progressListeners.size;
  }

  /** Test-only seam for building a tool-unavailable error. */
  buildToolUnavailableErrorForTesting(
    name: string,
    daemonRejection?: string,
    daemonGated = false,
  ): Promise<Error> {
    return this.toolUnavailableError(name, daemonRejection, daemonGated);
  }

  /**
   * Ensure we have a connection to the daemon
   * Will auto-start daemon if configured and daemon is not running
   */
  async ensureConnected(): Promise<void> {
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    const daemonShutdownDisconnect = this.daemonShutdownDisconnect;
    if (daemonShutdownDisconnect) {
      await daemonShutdownDisconnect;
      if (this.closing) {
        throw new DaemonUnavailableError("MCP proxy is closing");
      }
    }
    if (this.connected && this.client) {
      return;
    }

    try {
      const connecting = this.connectSingleFlight(this.connectionAllowsLifecycle());
      try {
        await connecting;
      } finally {
        this.clearConnectionAttempt(connecting);
      }
    } catch (error) {
      await this.handleConnectionFailure(error);
    }
  }

  private connectSingleFlight(allowsLifecycle: boolean): Promise<void> {
    this.assertConnectionPlanCompatible(allowsLifecycle);
    // Serialize socket publication, but never let observation-only work ride a lifecycle attempt.
    if (this.connecting) {
      return this.connecting;
    }
    const attempt = this.doConnect(allowsLifecycle);
    const connecting = new Promise<void>((resolve, reject) => {
      this.connectionCloseReject = reject;
      void attempt.then(resolve, reject);
    });
    this.connecting = connecting;
    this.connectingAllowsLifecycle = allowsLifecycle;
    return connecting;
  }

  private clearConnectionAttempt(connecting: Promise<void>): void {
    // Unpublish the settled attempt before originators or joiners await shared recovery.
    if (this.connecting === connecting) {
      this.connecting = null;
      this.connectionCloseReject = null;
      this.connectingAllowsLifecycle = false;
    }
  }

  private connectionAllowsLifecycle(): boolean {
    const allowed = daemonLifecycleAllowed();
    if (allowed) {
      this.throwIfLivenessHandedOver();
    }
    return allowed && !this.hasLivenessLifecycleFence();
  }

  private assertConnectionPlanCompatible(allowsLifecycle: boolean): void {
    if (this.connecting && !allowsLifecycle && this.connectingAllowsLifecycle) {
      throw new LifecycleConnectionInFlightError();
    }
  }

  private async handleConnectionFailure(error: unknown): Promise<void> {
    if (!daemonLifecycleAllowed() || !this.hasLivenessLifecycleFence()) {
      throw error;
    }
    await this.waitForLivenessRecovery();
    this.throwIfLivenessHandedOver();
    if (!this.connected || !this.client) {
      throw error;
    }
  }

  private throwIfClosing(): void {
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
  }

  private assertDaemonLifecycleUnfenced(): void {
    if (this.hasLivenessLifecycleFence()) {
      throw new DaemonUnavailableError(
        "Liveness recovery or handover forbids daemon lifecycle changes",
      );
    }
  }

  /**
   * Wait for liveness recovery of the sessions this proxy holds, bounded (#10508). Recovery spreads
   * its attempts over the lease, so an unbounded wait wedged every later call on the connection
   * for as long as recovery ran, including the call that would let the daemon resume the session.
   * The bound runs once per stretch of recovery, from the first call that waits on it: once it has
   * passed, later calls go ahead at once instead of each waiting it out again while the same
   * recovery keeps running. A call that goes ahead keeps its connection observation-only while the
   * fence holds, and a handover recorded meanwhile still surfaces from the caller's own checks.
   */
  private async waitForLivenessRecovery(signal?: AbortSignal): Promise<void> {
    if (
      !daemonLifecycleAllowed() ||
      !this.heldSessionUuids().some((uuid) => this.livenessRecovery.isRecovering(uuid))
    ) {
      return;
    }
    const deadline = this.livenessRecoveryCallDeadline();
    const timeoutMs = deadline - this.timer.now();
    if (timeoutMs <= 0) {
      // This stretch of recovery already used up its bound on an earlier call; the same recovery
      // is still running, and waiting it out again would wedge every call on the connection.
      logger.debug("[DaemonMcpProxy] Liveness recovery still running; call goes ahead without it");
      return;
    }
    try {
      await raceWithDeadline(this.livenessRecovery.settled(), {
        timer: this.timer,
        timeoutMs,
        signal,
        label: "Daemon liveness recovery",
      });
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[DaemonMcpProxy] Liveness recovery still running after ${timeoutMs}ms; going ahead without it`,
        error,
      );
    }
  }

  /** When calls stop waiting for the current stretch of recovery, fixed by its first waiting call. */
  private livenessRecoveryCallDeadline(): number {
    const episode = this.livenessRecovery.busyEpisode();
    if (this.livenessRecoveryCallWait?.episode !== episode) {
      this.livenessRecoveryCallWait = {
        episode,
        deadline:
          this.timer.now() +
          livenessRecoveryCallWaitMs(this.heartbeatLeashMs, this.heartbeatRequestTimeoutMs()),
      };
    }
    return this.livenessRecoveryCallWait.deadline;
  }

  private throwIfLivenessHandedOver(): void {
    const first = this.stallHandovers.entries().next().value;
    if (first) {
      const [sessionUuid, record] = first;
      throw new DaemonSessionStalledError(sessionUuid, record.handover);
    }
  }

  private async listDuringLivenessFence<T>(
    request: () => Promise<T>,
    coldList: () => T,
  ): Promise<T> {
    if (this.shouldServeLivenessDiscoveryCold()) {
      return coldList();
    }
    try {
      return await runWithoutDaemonLifecycle(request);
    } catch (error) {
      // Discovery is session-independent; an unreachable daemon keeps its existing cold surface.
      logger.debug("[DaemonMcpProxy] Fenced discovery unavailable; serving cold list", error);
      return coldList();
    }
  }

  private shouldServeLivenessDiscoveryCold(): boolean {
    return (
      this.hasLivenessLifecycleFence() &&
      (this.connecting !== null ||
        this.daemonShutdownDisconnect !== null ||
        this.heldSessionUuids().some((uuid) => this.livenessRecovery.isRecovering(uuid)))
    );
  }

  private hasLivenessLifecycleFence(): boolean {
    return (
      this.stallHandovers.size > 0 ||
      this.heldSessionUuids().some((uuid) => this.livenessRecovery.isRecovering(uuid))
    );
  }

  /**
   * What connecting must do about the daemon's lifecycle: `start` it (not running, auto-start on),
   * `reconcile` a running one with this client, or only `observe`. Liveness recovery shares the
   * daemon with other harnesses, so a connection it establishes only observes: it fails when the
   * daemon is not reachable and never starts it or reconciles it by restarting it.
   */
  private daemonLifecyclePlan(
    isAvailable: boolean,
    allowsLifecycle: boolean,
  ): "start" | "reconcile" | "observe" {
    if (!allowsLifecycle || this.hasLivenessLifecycleFence()) {
      if (!isAvailable) {
        throw new DaemonUnavailableError(
          "Daemon is not reachable; liveness recovery never starts or restarts the daemon",
        );
      }
      return "observe";
    }
    if (isAvailable) {
      return "reconcile";
    }
    if (!this.config.autoStartDaemon) {
      throw new DaemonUnavailableError("Daemon is not running and auto-start is disabled");
    }
    return "start";
  }

  private async doConnect(allowsLifecycle: boolean): Promise<void> {
    this.throwIfClosing();
    this.reconciliationSnapshot = undefined;
    this.structuredSessionNotFound = false;
    // Check if daemon is available
    const socketPath = this.config.socketPath ?? SOCKET_PATH;
    // This is an observation-only probe (issue #6140: isAvailable never touches
    // the filesystem). A daemon from another checkout may own this namespace's
    // socket without its PID record; cleaning the path before DaemonManager can
    // verify that candidate would sever a live daemon.
    const isAvailable = await this.daemonAvailabilityProbe(socketPath);

    const lifecycle = this.daemonLifecyclePlan(isAvailable, allowsLifecycle);
    if (lifecycle === "start") {
      logger.info("[DaemonMcpProxy] Daemon not available, starting daemon...");
      await this.startDaemon();
    }
    if (lifecycle !== "observe") {
      await this.ensureVersionMatches();
      await this.ensureAssetVersionPinMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    }

    // Reuse the socket status already read by reconciliation, after any restart.
    // Custom transports without a socket status probe retain legacy compatibility.
    if (this.daemonStatusProbe) {
      const status = await this.reconciliationStatus();
      this.structuredSessionNotFound = status.structuredSessionNotFound === true;
    }

    // Create and connect client
    this.throwIfClosing();
    this.client = this.clientFactory();
    const client = this.client;
    // Wire daemon-pushed list-changed forwarding (issue #3223) when the client
    // supports it. The handler is registered BEFORE connect so no early frame
    // is dropped; the opt-in subscription request goes out after connect.
    const supportsNotifications = [client.onNotification, client.subscribeToNotifications].every(
      (method) => typeof method === "function",
    );
    if (supportsNotifications) {
      this.notificationUnsubscribe?.();
      this.notificationUnsubscribe = client.onNotification!((notification) =>
        this.handleDaemonNotification(notification, client),
      );
    }
    this.subscribeToClientConnectionClosed(client);
    await runPreflightTransport(() => client.connect());
    if (this.closing) {
      await client.close();
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    logger.info("[DaemonMcpProxy] Connected to daemon");

    // Start notification opt-in BEFORE awaiting the ownership heartbeat so a
    // shutdown that releases the initial binding during that round trip cannot
    // publish to an unsubscribed socket (#6336). Do not await the subscription
    // yet: it is a best-effort daemon RPC that can stall up to the connection
    // timeout, while the time-critical first heartbeat must still be dispatched
    // immediately to beat the pre-first-heartbeat reclaim grace (#5637).
    const notificationSubscription = supportsNotifications
      ? client.subscribeToNotifications!().catch((error) => {
          logger.warn(`[DaemonMcpProxy] Failed to subscribe to daemon notifications: ${error}`);
        })
      : Promise.resolve();
    const [firstConnectionStep, secondConnectionStep] =
      this.connectionOwnershipAndPresentationSteps(client);
    await firstConnectionStep();
    await secondConnectionStep();
    // Re-check closing before the deferred flip: the establishment heartbeat awaits a
    // real daemon round-trip, and a close() landing during it already set
    // connected=false and nulled the client. Without this guard doConnect would
    // resume and set connected=true again — leaving a stale connected flag over a
    // closed transport (the old pre-await placement flipped before this await, so
    // close() ran last). Mirrors the closing rechecks above.
    this.throwIfClosing();
    // Fence the flip to the transport this attempt established (#6389): a socket
    // close during the establishment heartbeat already ran resetConnection() and
    // nulled the client, and the best-effort heartbeat swallowed the rejection.
    // Publishing connected=true now would pair the flag with a null client. No
    // request was dispatched on the lost transport, so surface it as a preflight
    // failure that withRecoverableReconnect reconnects from.
    this.assertConnectedClient(client);
    this.connected = true;
    this.cancelBackgroundConnectRetry();

    // Connection establishment still waits for the already-running subscription
    // so callers do not race later requests ahead of notification opt-in. Failure
    // was converted to a warning above and preserves the prior best-effort policy.
    await notificationSubscription;
    if (this.resourceSubscriptions.size > 0) {
      await this.replayResourceSubscriptions(client);
    }

    // If a client `tools/list` was served statically before this connection
    // existed (issue #5879), prompt it to re-fetch now that the daemon can
    // return the accurate (session-scoped) list. A no-op in the common case
    // where the static and live lists match; correct when a tool-selection
    // profile filters the live list.
    if (this.servedStaticToolList) {
      this.servedStaticToolList = false;
      this.notifyListChanged("tools");
    }
    if (this.servedStaticResourceList) {
      this.servedStaticResourceList = false;
      this.notifyListChanged("resources");
    }
  }

  private connectionOwnershipAndPresentationSteps(
    client: DaemonClientLike,
  ): readonly [() => Promise<void>, () => Promise<void>] {
    // Capture this before applying the profile: the first successful write
    // mints and stores the UUID. On first connect the profile must exist before
    // ownership establishment can publish `connected`; on reconnect the UUID is
    // already attached to concurrent calls, so reassert ownership first and
    // reapply the DB-backed presentation writes afterward. Keeping reconnect's
    // heartbeat ahead of those writes preserves the pre-first-heartbeat reclaim
    // grace guarantee (#5637).
    const isFirstPresentationProfileApplication = this.toolSelectionProfileUuid === undefined;
    const applyPresentationProfile = () => this.applyConnectionPresentationProfile(client);

    // On the FIRST establishment mark the proxy `connected` only AFTER the
    // establishment heartbeat lands (issue #5643). ensureConnected()'s fast path
    // returns as soon as `connected && client` is true; setting the flag before the
    // awaited first heartbeat would let a CONCURRENT ensureConnected() (a parallel
    // listTools/callTool during MCP startup) resolve and forward a request in the
    // sub-millisecond window before the daemon has recorded ownership. Deferring the
    // flip holds those concurrent callers on the `connecting` guard until ownership
    // is recorded; the heartbeat guards key off the live transport (`transportLive`),
    // not this flag, so the first heartbeat still fires while it is still false. On a
    // RECONNECT there is no ownership to wait for, so establishBoundSessionHeartbeat
    // flips `connected` itself before dispatching the keeper heartbeat (see there).
    const establishOwnership = () => this.establishBoundSessionHeartbeat();

    return isFirstPresentationProfileApplication
      ? [applyPresentationProfile, establishOwnership]
      : [establishOwnership, applyPresentationProfile];
  }

  /**
   * Materialize this frontend's presentation options on its daemon-issued
   * connection profile. The profile survives socket reconnects in this proxy,
   * while reapplying the writes makes daemon replacement safe without promoting
   * any of these options back to process-global startup state.
   */
  private async applyConnectionPresentationProfile(client: DaemonClientLike): Promise<void> {
    const {
      enabledTools = [],
      disabledTools = [],
      toolResultsNoStructuredContent,
      actionsCompactMetadata,
    } = this.config.daemonOptions ?? {};
    const updates = this.connectionPresentationUpdates(
      enabledTools,
      disabledTools,
      toolResultsNoStructuredContent,
      actionsCompactMetadata,
    );

    for (const update of updates) {
      const requestedArgs = {
        ...update,
        ...(toolResultsNoStructuredContent !== undefined
          ? {
              [INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM]: toolResultsNoStructuredContent,
            }
          : {}),
        ...(actionsCompactMetadata !== undefined
          ? { [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: actionsCompactMetadata }
          : {}),
      };
      const forwardedArgs = this.withToolSelectionProfile(requestedArgs);
      const result = await runPreflightTransport(() =>
        client.callTool(SET_TOOL_ENABLED_TOOL_NAME, forwardedArgs),
      );
      if (result?.isError) {
        throw new DaemonUnavailableError(
          `Failed to apply connection presentation profile: ${JSON.stringify(result)}`,
        );
      }
      this.rememberToolSelectionProfile(SET_TOOL_ENABLED_TOOL_NAME, requestedArgs, result);
      if (!this.toolSelectionProfileUuid) {
        throw new DaemonUnavailableError(
          "Daemon did not return a connection profile while applying presentation options",
        );
      }
    }
  }

  private connectionPresentationUpdates(
    enabledTools: string[],
    disabledTools: string[],
    toolResultsNoStructuredContent: boolean | undefined,
    actionsCompactMetadata: boolean | undefined,
  ): Array<{ toolNames: string[]; enabled: boolean }> {
    if (
      enabledTools.length === 0 &&
      disabledTools.length === 0 &&
      toolResultsNoStructuredContent === undefined &&
      actionsCompactMetadata === undefined
    ) {
      return [];
    }

    const updates: Array<{ toolNames: string[]; enabled: boolean }> = [];
    if (enabledTools.length > 0) {
      updates.push({ toolNames: [...enabledTools], enabled: true });
    }
    if (disabledTools.length > 0) {
      updates.push({ toolNames: [...disabledTools], enabled: false });
    }
    if (updates.length === 0) {
      // setToolEnabled is always-on; reaffirming it is a no-op that mints the
      // connection profile needed to carry a presentation-only policy.
      updates.push({ toolNames: [SET_TOOL_ENABLED_TOOL_NAME], enabled: true });
    }

    return updates;
  }

  // Drop the cached definitions for one list kind. Bumping the discovery epoch
  // makes a discovery request whose response is still in flight decline to
  // repopulate the cache this invalidation just cleared (issue #4655).
  private invalidateListCache(kind: ListChangedKind): void {
    this.discoveryEpoch += 1;
    if (kind === "tools") {
      this.cachedTools = null;
    } else {
      this.cachedResources = null;
      this.cachedResourceTemplates = null;
    }
  }

  // Invalidate the matching cache and re-emit a list_changed to listeners,
  // mirroring the daemon-pushed invalidation path (see handleDaemonNotification)
  // so a re-fetch is never stale.
  private notifyListChanged(kind: ListChangedKind): void {
    this.invalidateListCache(kind);
    for (const listener of this.listChangedListeners) {
      try {
        listener(kind);
      } catch (error) {
        // Best-effort re-emit: a dead/mid-teardown client transport must not
        // break sibling listeners.
        logger.warn(`[DaemonMcpProxy] list_changed listener failed for ${kind}: ${error}`);
      }
    }
  }

  /**
   * Register a listener for daemon-forwarded list-changed notifications
   * (issue #3223). The proxy invalidates the matching cache before firing, so
   * listeners re-fetching `listTools()`/`listResources()` always see fresh
   * definitions. Returns an unsubscribe function.
   */
  onListChanged(listener: (kind: ListChangedKind) => void): () => void {
    this.listChangedListeners.add(listener);
    return () => {
      this.listChangedListeners.delete(listener);
    };
  }

  /**
   * Register a listener told when automatic liveness recovery was exhausted (#10053), so a harness
   * that is idle between tool calls still learns a session was lost. The same structured error is
   * returned on the next tool call for an affected session.
   */
  onLivenessHandover(listener: (handover: LivenessHandover) => void): () => void {
    this.livenessHandoverListeners.add(listener);
    return () => {
      this.livenessHandoverListeners.delete(listener);
    };
  }

  onResourceUpdated(listener: (uri: string) => void): () => void {
    this.resourceUpdatedListeners.add(listener);
    return () => {
      this.resourceUpdatedListeners.delete(listener);
    };
  }

  async subscribeResource(uri: string): Promise<void> {
    this.throwIfClosing();
    this.resourceSubscriptions.add(uri);
    if (this.connected) {
      try {
        await this.syncResourceSubscription(uri);
      } catch (error) {
        this.resourceSubscriptions.delete(uri);
        throw toActionableError(error, "Failed to subscribe to resource");
      }
    } else {
      this.connectResourceSubscriptionsInBackground();
    }
  }

  async unsubscribeResource(uri: string): Promise<void> {
    this.throwIfClosing();
    this.resourceSubscriptions.delete(uri);
    if (this.connected) {
      await this.syncResourceSubscription(uri);
    }
  }

  private assertConnectedClient(client: DaemonClientLike): void {
    if (this.client !== client) {
      throw new DaemonPreflightConnectionError(
        new DaemonUnavailableError("Daemon socket closed during connection establishment"),
      );
    }
  }

  private async replayResourceSubscriptions(client: DaemonClientLike): Promise<void> {
    for (const uri of this.resourceSubscriptions) {
      try {
        await this.syncResourceSubscription(uri);
      } catch (error) {
        // Resource subscriptions are optional; rejection must not disable unrelated requests.
        logger.warn(`[DaemonMcpProxy] Failed to replay resource subscription ${uri}`, error);
        if (isPermanentResourceSubscriptionRejection(error)) {
          this.resourceSubscriptions.delete(uri);
        }
      }
    }
    this.throwIfClosing();
    this.assertConnectedClient(client);
  }

  private syncResourceSubscription(uri: string): Promise<void> {
    const client = this.client;
    const operation = this.resourceSubscriptionSync.then(async () => {
      if (!client || this.client !== client || this.closing) {
        return;
      }
      const method = this.resourceSubscriptions.has(uri)
        ? RESOURCE_SUBSCRIBE_METHOD
        : RESOURCE_UNSUBSCRIBE_METHOD;
      await client.callDaemonMethod(method, { uri });
    });
    // Keep subsequent mutations/replay ordered even after a failed RPC; its caller still rejects.
    this.resourceSubscriptionSync = operation.catch((error) => {
      logger.warn("[DaemonMcpProxy] Failed to synchronize resource subscription", error);
    });
    return operation;
  }

  private handleResourceUpdated(
    notification: DaemonNotification,
    sourceClient: DaemonClientLike,
  ): void {
    const uri = notification.uri;
    if (sourceClient !== this.client || !uri || !this.resourceSubscriptions.has(uri)) {
      return;
    }
    for (const listener of this.resourceUpdatedListeners) {
      try {
        listener(uri);
      } catch (error) {
        logger.warn("[DaemonMcpProxy] resource update listener failed", error);
      }
    }
  }

  private handleDaemonNotification(
    notification: DaemonNotification,
    sourceClient: DaemonClientLike,
  ): void {
    if (notification.method === RESOURCE_UPDATED_NOTIFICATION_METHOD) {
      this.handleResourceUpdated(notification, sourceClient);
      return;
    }
    if (notification.method === SESSION_RELEASED_NOTIFICATION_METHOD) {
      this.handleSessionReleasedNotification(notification);
      return;
    }

    if (notification.method === PROGRESS_NOTIFICATION_METHOD) {
      this.handleProgressNotification(notification, sourceClient);
      return;
    }

    const kind = listChangedKindForMethod(notification.method);
    if (kind === undefined) {
      // Unknown pushed methods are expected as the daemon grows new
      // notification families; ignoring keeps old proxies forward-compatible.
      logger.debug(`[DaemonMcpProxy] Ignoring unknown daemon notification: ${notification.method}`);
      return;
    }

    this.invalidateListCache(kind);
    if (kind === "tools") {
      this.reconciliationSnapshot = undefined;
    }

    for (const listener of this.listChangedListeners) {
      try {
        listener(kind);
      } catch (error) {
        // Best-effort re-emit: a dead/mid-teardown client transport must not
        // break cache invalidation or sibling listeners.
        logger.warn(`[DaemonMcpProxy] list_changed listener failed for ${kind}: ${error}`);
      }
    }
  }

  // A late or unmatched progress frame is expected around call completion.
  private handleProgressNotification(
    notification: DaemonNotification,
    sourceClient: DaemonClientLike,
  ): void {
    if (
      notification.requestId === undefined ||
      notification.progressToken === undefined ||
      notification.progress === undefined
    ) {
      return;
    }
    const registered = this.progressListeners.get(sourceClient)?.get(notification.requestId);
    if (registered?.progressToken !== notification.progressToken) {
      return;
    }
    try {
      registered.listener(notification.progress, notification.total, notification.message);
    } catch (error) {
      // Best-effort: a throwing progress consumer must never break the
      // notification channel or the in-flight tool call it belongs to.
      logger.warn(
        `[DaemonMcpProxy] progress listener failed for token ${notification.progressToken}: ${error}`,
      );
    }
  }

  private removeProgressListener(
    client: DaemonClientLike | undefined,
    requestId: string | undefined,
  ): void {
    if (!client || requestId === undefined) {
      return;
    }
    const listeners = this.progressListeners.get(client);
    listeners?.delete(requestId);
    if (listeners?.size === 0) {
      this.progressListeners.delete(client);
    }
  }

  private handleSessionReleasedNotification(notification: DaemonNotification): void {
    // Record the release against the specific UUID so an in-flight call that
    // forwarded it cannot re-remember it. Exact matching leaves unrelated and
    // derived sessions untouched; the replay TTL remains a dropped-frame
    // backstop (issues #4610, #4655).
    const releasedSessionUuid =
      typeof notification.sessionId === "string" && notification.sessionId.trim().length > 0
        ? notification.sessionId.trim()
        : undefined;
    if (!releasedSessionUuid) {
      return;
    }
    this.endLostSessionHandover(releasedSessionUuid);
    const isRecoverableHandoff =
      notification.reason !== undefined && isRecoverableDaemonReleaseReason(notification.reason);
    if (notification.reason === "daemon-shutdown") {
      // Daemon shutdown is connection-wide. Arm the successor barrier even when
      // this UUID belongs to an unresolved acquisition result that has not become
      // the current binding yet.
      this.waitForDaemonShutdownDisconnect();
    }
    if (this.isRecoverableBoundSessionHandoff(releasedSessionUuid, isRecoverableHandoff)) {
      // The replacement daemon rehydrates this UUID as awaiting-owner. Preserve
      // the binding so the next call/heartbeat can reclaim it after reconnecting.
      this.recoverableBoundSessionHandoff = releasedSessionUuid;
      this.livenessOwnershipClaimSent = false;
      const heldHandoff = this.otherHeldSessions.get(releasedSessionUuid);
      if (heldHandoff) {
        heldHandoff.claimSent = false;
      }
      this.discoveryEpoch += 1;
      this.invalidateCache();
      return;
    }
    this.recordSessionReleased(releasedSessionUuid, notification.reason);
    // A released session is no longer owned: drop it so a later fresh-screenshot
    // read stops owner-routing to it and falls back to the live binding (which the
    // daemon denies), matching the "released session remains denied" guarantee
    // (issue #5663).
    this.ownedDeviceSessions.delete(releasedSessionUuid);
    this.claimableSessions.delete(releasedSessionUuid);
    this.dropHeldSession(releasedSessionUuid);
    if (
      releasedSessionUuid === this.boundSessionUuid ||
      releasedSessionUuid === this.terminalBoundSession?.sessionUuid
    ) {
      this.fenceBoundSessionUuid(
        releasedSessionUuid,
        notification.reason ?? "released",
        notification.release,
      );
    }
  }

  private isRecoverableBoundSessionHandoff(
    releasedSessionUuid: string,
    isRecoverableHandoff: boolean,
  ): boolean {
    return isRecoverableHandoff && this.ownedDeviceSessions.has(releasedSessionUuid);
  }

  private hasRecoverableBoundSessionHandoff(): boolean {
    return (
      this.recoverableBoundSessionHandoff !== undefined &&
      this.recoverableBoundSessionHandoff === this.boundSessionUuid
    );
  }

  private waitForDaemonShutdownDisconnect(): void {
    if (this.daemonShutdownDisconnect || !this.client) {
      return;
    }
    const disconnect = Promise.withResolvers<void>();
    let peerDisconnected = false;
    const completeDisconnect = (): void => {
      peerDisconnected = true;
      disconnect.resolve();
    };
    const timeoutHandle = this.timer.setTimeout(disconnect.resolve, DAEMON_SHUTDOWN_TIMEOUT_MS);
    const barrier = disconnect.promise
      .then(async () => {
        this.timer.clearTimeout(timeoutHandle);
        if (!peerDisconnected) {
          if (this.resolveDaemonShutdownDisconnect === completeDisconnect) {
            this.resolveDaemonShutdownDisconnect = null;
          }
          // A stalled transport must not remain attached after the bounded EOF
          // wait. resetConnection detaches it synchronously before closing it.
          void this.resetConnection();
        }
        await this.waitForDaemonShutdownRestartWindow();
      })
      .catch((error) => {
        // Readiness is re-checked by doConnect; this barrier only prevents the
        // deterministic stale-PID/no-startup-lock gap from racing that path.
        logger.warn(`[DaemonMcpProxy] Failed while awaiting daemon restart transition: ${error}`);
      });
    this.daemonShutdownDisconnect = barrier;
    this.resolveDaemonShutdownDisconnect = completeDisconnect;
    void barrier.then(() => {
      if (this.daemonShutdownDisconnect === barrier) {
        this.daemonShutdownDisconnect = null;
      }
    });
    // Keep the old client attached long enough to observe peer EOF, but prevent
    // ensureConnected() from treating this quiesced incarnation as reusable.
    this.connected = false;
    if (typeof this.client.onConnectionClosed !== "function") {
      // This client cannot report peer EOF. Begin detaching now; the timeout
      // still bounds a custom close() implementation that never settles.
      void this.resetConnection();
    }
  }

  private completeDaemonShutdownDisconnect(
    expectedResolve: (() => void) | null = this.resolveDaemonShutdownDisconnect,
  ): void {
    if (this.resolveDaemonShutdownDisconnect !== expectedResolve) {
      return;
    }
    this.resolveDaemonShutdownDisconnect = null;
    expectedResolve?.();
  }

  private async waitForDaemonShutdownRestartWindow(): Promise<void> {
    const socketPath = this.config.socketPath ?? SOCKET_PATH;
    let deadline =
      this.timer.now() + Math.max(DAEMON_STARTUP_TIMEOUT_MS, DAEMON_RESTART_HANDOFF_TIMEOUT_MS);
    let emptyHandoffDeadline: number | undefined;
    while (!this.closing && this.timer.now() < deadline) {
      if (await this.daemonAvailabilityProbe(socketPath)) {
        return;
      }
      const status = await this.daemonManager.status();
      const startupLockHeld = this.daemonManager.isStartupLockHeldByLiveProcess();
      if (startupLockHeld && this.config.autoStartDaemon) {
        // doConnect() may now join the lock holder through DaemonManager.start().
        return;
      }
      if (startupLockHeld || status.running) {
        // A successor has begun publishing ownership. Clients with auto-start
        // disabled cannot join its lock, so keep their barrier active until its
        // socket becomes reachable under the overall startup deadline.
        emptyHandoffDeadline = undefined;
      } else {
        // Explicit restart deliberately leaves no PID and no startup lock while
        // it pauses between stop and start. Preserve that handoff instead of
        // racing to start a daemon with this proxy's potentially different
        // options.
        emptyHandoffDeadline ??= this.timer.now() + DAEMON_RESTART_HANDOFF_TIMEOUT_MS;
        // A short startup-timeout override must not truncate the complete
        // bounded restart preflight after the empty handoff is first observed.
        deadline = Math.max(deadline, emptyHandoffDeadline);
        if (this.timer.now() >= emptyHandoffDeadline) {
          return;
        }
      }
      const waitDeadline = emptyHandoffDeadline ?? deadline;
      await this.timer.sleep(Math.min(100, waitDeadline - this.timer.now()));
    }
  }

  private createStatusProbe(
    config: DaemonMcpProxyConfig,
  ): (() => Promise<DaemonStatus>) | undefined {
    // Custom transports supply their matching probe separately; constructing a
    // default socket client here would escape an injected transport/test seam.
    if (config.daemonStatusProbe) {
      return config.daemonStatusProbe;
    }
    if (config.clientFactory) {
      return undefined;
    }
    return () =>
      new DaemonClient(this.config.socketPath, this.config.connectionTimeoutMs).getDaemonStatus();
  }

  private reconciliationStatus(): Promise<DaemonStatus> {
    if (!this.daemonStatusProbe) {
      return this.daemonManager.status();
    }
    this.reconciliationSnapshot ??= this.readSocketReconciliationStatus();
    return this.reconciliationSnapshot;
  }

  private isSameDaemonGeneration(current: DaemonStatus, expected: DaemonStatus): boolean {
    if (!current.running || !expected.running || current.pid !== expected.pid) {
      return false;
    }
    const identityFields = ["startedAt", "version", "buildId", "entryScript"] as const;
    return identityFields.every(
      (field) => expected[field] === undefined || current[field] === expected[field],
    );
  }

  /**
   * A competing client can observe the incumbent during an admitted restart's
   * intentional handoff gap. Wait for a different, running generation instead
   * of treating that gap as a completed reconciliation.
   */
  private async waitForJoinedRestartSuccessor(
    expected: DaemonStatus,
    deadline: number,
  ): Promise<DaemonStatus> {
    let initialProbe = true;
    while (initialProbe || this.timer.now() < deadline) {
      initialProbe = false;
      try {
        const status = await this.reconciliationStatus();
        if (status.running && !this.isSameDaemonGeneration(status, expected)) {
          return status;
        }
      } catch (error) {
        if (!(error instanceof DaemonPreflightConnectionError)) {
          throw error;
        }
        // A missing socket is expected while the restart owner changes generations.
        logger.debug(`[DaemonMcpProxy] Waiting for joined restart successor: ${error.message}`);
      }
      this.reconciliationSnapshot = undefined;
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        break;
      }
      await this.timer.sleep(Math.min(DAEMON_RESTART_HANDOFF_DELAY_MS, remaining));
      this.reconciliationSnapshot = undefined;
    }
    throw new DaemonUnavailableError(
      `Timed out waiting for concurrent daemon restart after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
    );
  }

  private async waitForRunningReconciliationStatus(deadline: number): Promise<DaemonStatus> {
    let initialProbe = true;
    while (initialProbe || this.timer.now() < deadline) {
      initialProbe = false;
      try {
        const status = await this.reconciliationStatus();
        if (status.running) {
          return status;
        }
      } catch (error) {
        if (!(error instanceof DaemonPreflightConnectionError)) {
          throw error;
        }
        // A follow-up reconciler may temporarily remove the incumbent socket.
        logger.debug(`[DaemonMcpProxy] Waiting through restart handoff: ${error.message}`);
      }
      this.reconciliationSnapshot = undefined;
      const remaining = deadline - this.timer.now();
      if (remaining <= 0) {
        break;
      }
      await this.timer.sleep(Math.min(DAEMON_RESTART_HANDOFF_DELAY_MS, remaining));
      this.reconciliationSnapshot = undefined;
    }
    throw new DaemonUnavailableError(
      `Timed out waiting for daemon reconciliation after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
    );
  }

  private async readSocketReconciliationStatus(): Promise<DaemonStatus> {
    const recorded = await this.daemonManager.status();
    const actual = await runPreflightTransport(() => this.daemonStatusProbe!());
    // Compatibility allows legacy missing build fields, but missing identity is not
    // evidence that a PID record belongs to this socket. Only enrich a known matching
    // process, build and entry script; never manufacture live build/options from a legacy probe.
    const actualBuild = buildIdentityFromStatus(actual);
    const matchesRecord =
      recorded.running &&
      actual.pid !== undefined &&
      actual.pid === recorded.pid &&
      recorded.version === actual.version &&
      actualBuild.buildId !== "unknown" &&
      actualBuild.buildId.length > 0 &&
      actualBuild.entryScript.length > 0 &&
      recorded.buildId === actualBuild.buildId &&
      recorded.entryScript === actualBuild.entryScript;
    // Only the socket owner can advertise support, even when PID metadata matches.
    return matchesRecord
      ? { ...recorded, ...actual, structuredSessionNotFound: actual.structuredSessionNotFound }
      : actual;
  }

  private assertAutomaticRestartAllowed(status: DaemonStatus, reason: string): void {
    this.assertDaemonLifecycleUnfenced();
    if (status.activeProvisioning) {
      throw new DaemonRestartDeferredError(reason);
    }
  }

  /** Newer clients may replace older daemons; mismatches remain a pre-dispatch gate. */
  private async ensureVersionMatches(
    reconciliationDeadline = this.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    const status = observedStatus ?? (await this.reconciliationStatus());
    if (!status.running) {
      return;
    }

    const runningVersion = status.version?.trim() ?? "";
    if (runningVersion === this.clientVersion) {
      return;
    }

    if (!this.requiresVersionRestart(status, runningVersion)) {
      return;
    }

    // Reach here when the client is strictly newer OR the daemon is a same-release
    // dev-skew (different git stamp). Both reconcile by restarting the daemon from
    // this client's build. Same-release dev-skew must be handled HERE rather than
    // deferred to ensureBuildMatches: the build-identity hash covers only the entry
    // script (process.argv[1]), so in unbundled source-mode runs (`bun src/index.ts`)
    // it is blind to commits that change non-entry files — the git stamp is the only
    // signal. The restart is cooldown-bounded below so two checkouts cannot thrash.

    this.assertVersionRestartCooldownExpired(status, runningVersion);

    if (this.timer.now() >= reconciliationDeadline) {
      throw new DaemonUnavailableError(
        `Timed out waiting for concurrent daemon restart after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    logger.info(
      `[DaemonMcpProxy] Daemon version ${runningVersion || "unknown"} differs from MCP server ${this.clientVersion}, restarting daemon`,
    );
    this.assertAutomaticRestartAllowed(status, "version mismatch");
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    const restartResult = await this.daemonManager.restart(
      mergeDaemonOptions(status.options, this.config.daemonOptions),
      status,
    );
    this.reconciliationSnapshot = undefined;
    if (restartResult === "joined") {
      const successorStatus = await this.waitForJoinedRestartSuccessor(
        status,
        reconciliationDeadline,
      );
      return await this.ensureVersionMatches(reconciliationDeadline, successorStatus);
    }
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.invalidateCache();
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    await this.verifyRestartedVersion();
  }

  private async verifyRestartedVersion(): Promise<void> {
    const restartedStatus = await this.reconciliationStatus();
    const restartedVersion = restartedStatus.version?.trim() ?? "";
    if (!restartedStatus.running || restartedVersion !== this.clientVersion) {
      throw this.versionMismatchError(
        restartedVersion,
        "restartMismatch",
        "daemon restart completed but version still differs",
        undefined,
        buildIdentityFromStatus(restartedStatus),
      );
    }
  }

  private requiresVersionRestart(status: DaemonStatus, runningVersion: string): boolean {
    // The release portions (before the `+g<sha>` dev stamp) drive the
    // newer/older decision. A plain release client intentionally matches a
    // source-stamped daemon at that release; two stamped versions still detect
    // source-checkout dev-skew.
    const runningBase = releaseVersion(runningVersion);
    const clientBase = releaseVersion(this.clientVersion);
    const sameRelease = runningBase === clientBase;
    const clientDeclaresFullVersion = clientBase !== this.clientVersion;

    if (sameRelease && !clientDeclaresFullVersion) {
      return false;
    }

    if (!this.config.autoStartDaemon) {
      throw this.versionMismatchError(
        runningVersion,
        "autoStartDisabled",
        "auto-start is disabled",
        undefined,
        buildIdentityFromStatus(status),
      );
    }

    this.assertNewerClientVersion(status, runningVersion, runningBase, clientBase, sameRelease);
    return true;
  }

  private assertNewerClientVersion(
    status: DaemonStatus,
    runningVersion: string,
    runningBase: string,
    clientBase: string,
    sameRelease: boolean,
  ): void {
    if (!sameRelease) {
      const cmp =
        runningBase.length > 0
          ? compareStrictNumericVersions(clientBase, runningBase)
          : Number.POSITIVE_INFINITY;

      if (runningBase.length > 0 && !Number.isFinite(cmp)) {
        throw this.versionMismatchError(
          runningVersion,
          "nonNumeric",
          "version comparison is not numeric",
          undefined,
          buildIdentityFromStatus(status),
        );
      }

      if (cmp <= 0) {
        throw this.versionMismatchError(
          runningVersion,
          "daemonNewer",
          "the running daemon is newer than this client",
          undefined,
          buildIdentityFromStatus(status),
        );
      }
    }
  }

  private assertVersionRestartCooldownExpired(status: DaemonStatus, runningVersion: string): void {
    if (status.startedAt) {
      const daemonAgeMs = this.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonMcpProxy] Skipping version-mismatch restart due to cooldown: daemon ${runningVersion || "unknown"} is ${daemonAgeMs}ms old, client version is ${this.clientVersion}`,
        );
        throw this.versionMismatchError(
          runningVersion,
          "cooldown",
          "restart is in cooldown",
          DAEMON_VERSION_RESTART_COOLDOWN_MS - daemonAgeMs,
          buildIdentityFromStatus(status),
        );
      }
    }
  }

  private versionMismatchError(
    runningVersion: string,
    reason: VersionMismatchReason,
    detail: string,
    retryAfterMs?: number,
    daemonBuild?: BuildIdentity,
  ): DaemonVersionMismatchError {
    const daemonVersion = runningVersion.length > 0 ? runningVersion : "unknown";
    const clientVersion = this.clientVersion.trim();
    return new DaemonVersionMismatchError({
      clientVersion,
      daemonVersion,
      reason,
      detail,
      retryAfterMs,
      clientBuild: this.buildIdentity,
      daemonBuild,
    });
  }

  private async ensureAssetVersionPinMatches(): Promise<void> {
    if (!this.clientAssetVersion) {
      return;
    }
    const status = await this.reconciliationStatus();
    if (!status.running) {
      return;
    }
    const daemonAssetVersion = status.assetVersion?.trim() ?? "";
    if (daemonAssetVersion === this.clientAssetVersion) {
      return;
    }
    throw new DaemonAssetVersionMismatchError(
      this.clientAssetVersion,
      daemonAssetVersion.length > 0 ? daemonAssetVersion : "unknown",
    );
  }

  /**
   * Ensure the client never attaches to a daemon built from a *different* checkout.
   * The version string alone cannot detect this (two checkouts can both report the
   * same pre-release version), so we compare a content hash of the entry script.
   * On mismatch, restart the daemon from this client's own entrypoint so the live
   * frontend and backend run the same code. Independent of, and complementary to,
   * {@link ensureVersionMatches}.
   */
  private async ensureBuildMatches(
    reconciliationDeadline = this.timer.now() + DAEMON_STARTUP_TIMEOUT_MS,
    observedStatus?: DaemonStatus,
  ): Promise<void> {
    const status = observedStatus ?? (await this.reconciliationStatus());
    if (!status.running) {
      return;
    }

    const daemonIdentity = buildIdentityFromStatus(status);
    if (buildIdentitiesMatch(this.buildIdentity, daemonIdentity)) {
      return;
    }

    if (!this.config.autoStartDaemon) {
      throw this.buildMismatchError(daemonIdentity, "autoStartDisabled", "auto-start is disabled");
    }

    if (status.startedAt) {
      const daemonAgeMs = this.timer.now() - status.startedAt;
      if (daemonAgeMs < DAEMON_VERSION_RESTART_COOLDOWN_MS) {
        logger.warn(
          `[DaemonMcpProxy] Skipping build-mismatch restart due to cooldown: daemon build ${daemonIdentity.buildId} is ${daemonAgeMs}ms old, client build is ${this.buildIdentity.buildId}`,
        );
        throw this.buildMismatchError(
          daemonIdentity,
          "cooldown",
          "restart is in cooldown",
          DAEMON_VERSION_RESTART_COOLDOWN_MS - daemonAgeMs,
        );
      }
    }

    if (this.timer.now() >= reconciliationDeadline) {
      throw new DaemonUnavailableError(
        `Timed out waiting for concurrent daemon restart after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    logger.info(
      `[DaemonMcpProxy] Daemon build ${daemonIdentity.buildId} (${daemonIdentity.entryScript || "unknown"}) differs from client build ${this.buildIdentity.buildId} (${this.buildIdentity.entryScript || "unknown"}), restarting daemon`,
    );
    this.assertAutomaticRestartAllowed(status, "build mismatch");
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    const restartResult = await this.daemonManager.restart(
      mergeDaemonOptions(status.options, this.config.daemonOptions),
      status,
    );
    this.reconciliationSnapshot = undefined;
    return await this.finishBuildRestart(restartResult, status, reconciliationDeadline);
  }

  private async finishBuildRestart(
    restartResult: DaemonRestartResult,
    status: DaemonStatus,
    reconciliationDeadline: number,
  ): Promise<void> {
    if (restartResult === "joined") {
      const successorStatus = await this.waitForJoinedRestartSuccessor(
        status,
        reconciliationDeadline,
      );
      return await this.ensureBuildMatches(reconciliationDeadline, successorStatus);
    }
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.invalidateCache();
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    const restartedStatus = await this.reconciliationStatus();
    const restartedIdentity = buildIdentityFromStatus(restartedStatus);
    if (!restartedStatus.running || !buildIdentitiesMatch(this.buildIdentity, restartedIdentity)) {
      throw this.buildMismatchError(
        restartedIdentity,
        "restartMismatch",
        "daemon restart completed but build still differs",
      );
    }
  }

  private buildMismatchError(
    daemon: BuildIdentity,
    reason: BuildMismatchReason,
    detail: string,
    retryAfterMs?: number,
  ): DaemonBuildMismatchError {
    return new DaemonBuildMismatchError({
      client: this.buildIdentity,
      daemon,
      reason,
      detail,
      retryAfterMs,
    });
  }

  private async ensureStartupOptionsMatch(): Promise<void> {
    const requested = this.config.daemonOptions;
    const reconciliationDeadline = this.timer.now() + DAEMON_STARTUP_TIMEOUT_MS;
    while (this.timer.now() < reconciliationDeadline) {
      const status = await this.reconciliationStatus();
      if (!status.running) {
        return;
      }

      const deficits = startupOptionDeficits(requested, status.options);
      if (deficits.length === 0) {
        return;
      }

      if (!this.config.autoStartDaemon) {
        throw new DaemonUnavailableError(
          `Daemon startup options differ from MCP server options (${deficits.join(", ")}) and auto-start is disabled`,
        );
      }

      logger.info(
        `[DaemonMcpProxy] Daemon startup options differ (${deficits.join(", ")}), restarting daemon`,
      );
      this.assertAutomaticRestartAllowed(status, "startup option mismatch");
      // Preserve the running daemon's existing options and add the requested ones
      // so the restart gains the missing flag without stripping any the daemon
      // already had (issue #3846).
      const restartResult = await this.daemonManager.restart(
        mergeDaemonOptions(status.options, requested),
        status,
      );
      this.reconciliationSnapshot = undefined;
      if (restartResult === "joined") {
        const successorStatus = await this.waitForJoinedRestartSuccessor(
          status,
          reconciliationDeadline,
        );
        const remaining = startupOptionDeficits(requested, successorStatus.options);
        if (remaining.length === 0) {
          return;
        }
        if (this.timer.now() >= reconciliationDeadline) {
          break;
        }
        continue;
      }

      const readinessTimeout = Math.max(0, reconciliationDeadline - this.timer.now());
      await this.daemonManager.waitForReady(readinessTimeout);

      const restartedStatus = await this.waitForRunningReconciliationStatus(reconciliationDeadline);
      const remaining = startupOptionDeficits(requested, restartedStatus.options);
      if (remaining.length > 0) {
        throw new DaemonUnavailableError(
          `Daemon process handoff completed (pid ${status.pid ?? "unknown"} -> pid ${restartedStatus.pid ?? "unknown"}), ` +
            `but the successor for the shared per-user daemon still does not satisfy the requested startup options ` +
            `(${remaining.join(", ")}). A different owner or launch path may control the replacement configuration. ` +
            startupOptionRecoveryGuidance(),
        );
      }
      return;
    }
    throw new DaemonUnavailableError(
      `Timed out waiting for concurrent daemon startup-option reconciliation after ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
    );
  }

  /**
   * Start the daemon process
   */
  private async startDaemon(): Promise<void> {
    const status = await this.daemonManager.status();
    this.assertDaemonLifecycleUnfenced();

    if (!status.running) {
      logger.info("[DaemonMcpProxy] Starting daemon...");
      // Pass through daemon options (debug flags, video defaults, etc.)
      await this.daemonManager.start(daemonProcessOptions(this.config.daemonOptions));

      // Wait for daemon to be ready
      const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
      if (!ready) {
        throw new DaemonUnavailableError(
          `Daemon failed to start within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
        );
      }
      logger.info("[DaemonMcpProxy] Daemon started successfully");
      return;
    }

    // The daemon reports running but startDaemon is only reached when the
    // observation-only socket probe (DaemonClient.isAvailable) failed — i.e. the
    // socket is not connectable yet. A daemon in-progress startup writes its
    // early-owner PID record (daemon.ts writeEarlyOwnerRecord) BEFORE publishing
    // the Unix socket, which appears seconds later once DB init, device-pool
    // discovery, and iOS services complete. Treat that missing socket as pending
    // readiness, not a terminal error: wait behind the same bounded readiness
    // path so publication can complete instead of letting the subsequent
    // client.connect() fail immediately with "Daemon socket not found" (issue
    // #5664). waitForReady polls the socket + verifyDaemonConnection and never
    // unlinks a live daemon's socket, so stale-socket / dead-daemon handling and
    // the "do not replace a live daemon's socket" contract are preserved. A
    // genuinely wedged daemon that never publishes still fails promptly at the
    // deadline with an actionable error.
    //
    // This wait is nested inside a `tools/list` request that clients cut off at
    // ~30s (DAEMON_STARTUP_TIMEOUT_MS); if the error it can throw is produced only
    // as that deadline expires, the client sees an AutoMobile server with zero
    // tools and no error text (issue #5878, residual of #5871/#5874). So keep the
    // full startup budget while a live process is actively bringing the daemon up
    // — a legitimate concurrent cold start writes its early-owner PID (making
    // status.running true) seconds before it publishes the socket, and abandoning
    // it early would reject a start that was about to succeed — but exit the moment
    // no live startup-lock holder remains. A genuinely wedged or orphaned daemon
    // (early-owner record present, socket unreachable, no live holder finishing the
    // start) is then reported now instead of at the client's deadline, while the
    // concurrent-cold-start case keeps the budget it needs.
    // Re-arbitrate across replacement holders under one deadline, exactly like the
    // double-lock-contention loop in DaemonManager.start (issue #5904): if the live
    // holder A crashes and a replacement B reclaims the lock to finish the start, a
    // single liveness-gated waitForReady would give up on A and throw even though B
    // is now bringing the daemon up. waitForLockHolderReadiness keeps the full budget
    // per live holder and only reports failure once no live holder remains.
    const ready = await this.daemonManager.waitForLockHolderReadiness(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon reported running but its socket did not become reachable, and no live ` +
          `process is completing its startup`,
      );
    }
    logger.info("[DaemonMcpProxy] Daemon reported running; socket became ready");
  }

  private async withRecoverableReconnect<T>(
    operation: () => Promise<T>,
    attemptedSessionUuid?: string,
    allowReleasedSession?: boolean,
    fenceSessionNotFoundOnRetry = true,
    nonIdempotentToolName?: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    signal.throwIfAborted();
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    this.throwIfBoundSessionFenced(allowReleasedSession);
    const reconnectRecoverableHandoff = this.hasRecoverableBoundSessionHandoff();
    if (reconnectRecoverableHandoff) {
      await this.resetConnection();
      // doConnect restarts the heartbeat keeper. Clear the marker before that
      // asynchronous tick can enter withRecoverableReconnect and reset the new
      // transport beneath the operation that is reclaiming this UUID.
      this.recoverableBoundSessionHandoff = undefined;
    }
    let established = false;

    try {
      // Socket identity discovery can race a daemon handoff before any tool
      // has been dispatched. Give establishment the same single reconnect
      // attempt as a recoverable transport failure, preserving the fences.
      await this.ensureConnected();
      signal.throwIfAborted();
      this.throwIfBoundSessionFenced(allowReleasedSession);
      established = true;
      return await operation();
    } catch (error) {
      signal.throwIfAborted();
      if (this.closing) {
        throw error;
      }
      this.throwIfBoundSessionFenced(allowReleasedSession);
      this.throwIfBoundSessionLost(error);
      if (!this.isRecoverableDaemonSessionError(error, established)) {
        throw error;
      }
      if (error instanceof DaemonShuttingDownError) {
        this.waitForDaemonShutdownDisconnect();
      }
      const refusedToolName = this.ambiguousReplayToolName(
        error,
        established,
        nonIdempotentToolName,
      );
      if (refusedToolName !== undefined) {
        // The tool may have reached the daemon and run. Reset the dead transport
        // for the next call, but never re-run this one (issue #6382).
        await this.resetConnection();
        throw new DaemonToolOutcomeUnknownError(refusedToolName, error);
      }

      logger.warn(
        `[DaemonMcpProxy] Daemon session is stale, reconnecting and retrying once: ${errorMessage(error)}`,
      );
      await this.resetConnection();
      signal.throwIfAborted();
      this.throwIfBoundSessionFenced(allowReleasedSession);
      await this.ensureConnected();
      signal.throwIfAborted();
      this.throwIfBoundSessionFenced(allowReleasedSession);
      try {
        return await operation();
      } catch (retryError) {
        signal.throwIfAborted();
        this.throwIfBoundSessionFenced(allowReleasedSession);
        const sessionNotFoundFenceTarget = this.sessionNotFoundFenceTarget(
          retryError,
          attemptedSessionUuid,
          fenceSessionNotFoundOnRetry,
        );
        if (sessionNotFoundFenceTarget) {
          this.fenceBoundSessionUuid(sessionNotFoundFenceTarget, "session-not-found");
          throw this.boundSessionExpiredError();
        }
        await this.throwIfRetryOutcomeUnknown(retryError, nonIdempotentToolName);
        throw retryError;
      }
    }
  }

  /**
   * The single retry of a non-idempotent tool reached a written frame before the
   * transport failed again: the retried call may have run, so surface the same
   * outcome-unknown error as a first attempt instead of the raw transport error
   * (an agent that sees only "Socket connection closed" would retry the action).
   * A retry that provably never reached the daemon stays a plain not-delivered
   * failure; nothing is retried again either way.
   */
  private async throwIfRetryOutcomeUnknown(
    retryError: unknown,
    nonIdempotentToolName: string | undefined,
  ): Promise<void> {
    if (!this.isRecoverableDaemonSessionError(retryError, true)) {
      return;
    }
    const refusedToolName = this.ambiguousReplayToolName(retryError, true, nonIdempotentToolName);
    if (refusedToolName === undefined) {
      return;
    }
    await this.resetConnection();
    throw new DaemonToolOutcomeUnknownError(refusedToolName, retryError);
  }

  private sessionNotFoundFenceTarget(
    error: unknown,
    attemptedSessionUuid: string | undefined,
    fenceSessionNotFoundOnRetry: boolean,
  ): string | undefined {
    if (
      !fenceSessionNotFoundOnRetry ||
      !attemptedSessionUuid ||
      this.boundSessionUuid !== attemptedSessionUuid ||
      !this.isDaemonSessionNotFoundError(error)
    ) {
      return undefined;
    }
    return attemptedSessionUuid;
  }

  private isRecoverableDaemonSessionError(error: unknown, established = true): boolean {
    if (!established) {
      return error instanceof DaemonPreflightConnectionError;
    }
    // Compatibility policy failures cannot be healed by another connection
    // attempt (and repeating a failed reconciliation could restart twice).
    if (
      error instanceof DaemonVersionMismatchError ||
      error instanceof DaemonBuildMismatchError ||
      error instanceof DaemonAssetVersionMismatchError
    ) {
      return false;
    }
    // Structured server evidence proves rejection happened before dispatch.
    // Legacy message-only errors remain non-retryable rather than guessing.
    if (error instanceof DaemonHandshakeMismatchError) {
      return true;
    }
    if (error instanceof DaemonUnavailableError) {
      return true;
    }

    // "Unknown tool" is recoverable only when the frontend advertises that tool.
    // A reconnect cannot make a frontend-unregistered name exist in the daemon.
    return this.isDaemonSessionNotFoundError(error) || this.isRecoverableUnknownToolError(error);
  }

  private throwIfBoundSessionLost(error: unknown): void {
    if (!(error instanceof DaemonBoundSessionLostError)) {
      return;
    }
    if (error.failure.sessionUuid !== this.boundSessionUuid) {
      throw new DaemonBoundSessionExpiredError(
        error.failure.sessionUuid,
        error.failure.reason,
        error.failure.release,
      );
    }
    this.fenceBoundSessionUuid(
      error.failure.sessionUuid,
      error.failure.reason,
      error.failure.release,
    );
    throw this.boundSessionExpiredError();
  }

  /**
   * The non-idempotent tool whose replay must be refused because nothing proves
   * the failed attempt never dispatched it; undefined when a replay is safe.
   * Before establishment the operation never ran, so a replay is always safe.
   */
  private ambiguousReplayToolName(
    error: unknown,
    established: boolean,
    nonIdempotentToolName: string | undefined,
  ): string | undefined {
    if (!established || this.isProvablyUndispatchedError(error)) {
      return undefined;
    }
    return nonIdempotentToolName;
  }

  /**
   * Structured evidence that the daemon never dispatched the request: the frame
   * was never written, or the daemon rejected it before admission. Message
   * substrings (e.g. "Session not found") are deliberately not evidence here.
   */
  private isProvablyUndispatchedError(error: unknown): boolean {
    return (
      error instanceof DaemonRequestNotDeliveredError ||
      (error instanceof DaemonShuttingDownError && !error.requestMayHaveDispatched) ||
      error instanceof DaemonHandshakeMismatchError ||
      isMcpQueueTimeoutError(error) ||
      this.isRecoverableUnknownToolError(error)
    );
  }

  private isDaemonSessionNotFoundError(error: unknown): boolean {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code !== undefined
    ) {
      return error.code === DAEMON_SESSION_NOT_FOUND_CODE;
    }
    if (this.structuredSessionNotFound) {
      return false;
    }
    // Older daemons return only the bare message, without a structured error code.
    return errorMessage(error).includes("Session not found");
  }

  private isPreDispatchDaemonSessionError(error: unknown): boolean {
    return (
      this.isUnknownToolError(error) ||
      errorMessage(error).includes("is not an active daemon session")
    );
  }

  private isUnknownToolError(error: unknown): boolean {
    const message = errorMessage(error);
    return this.isGatedToolError(error) || message.includes("Unknown tool:");
  }

  /**
   * The daemon registers the tool but its availability gate (debug-only,
   * embedded-SDK-only, plan-only) rejected the call (issue #10177). Structured
   * code only: the gate-reason prose is never parsed. A daemon that predates the
   * code sends none, so it falls through to the stale-daemon recovery below —
   * that daemon is necessarily a different build than this proxy, so the
   * reconnect re-runs the build-identity reconciliation and replaces it.
   */
  private isGatedToolError(error: unknown): boolean {
    return isGatedToolErrorCode(error);
  }

  private isRecoverableUnknownToolError(error: unknown): boolean {
    // A gate is daemon configuration, not skew: a reconnect cannot lift it, and
    // resetting would abort every sibling call in flight on the shared client.
    if (this.isGatedToolError(error)) {
      return false;
    }
    const match = errorMessage(error).match(/Unknown tool:\s*(\S+)/);
    if (!match) {
      return this.isUnknownToolError(error);
    }
    const name = match[1].replace(/[.,;:!?]+$/, "");
    return name.length === 0 || this.frontendRegistersTool(name);
  }

  private shouldSkipLeaseRefreshForDeviceControlTransportError(error: unknown): boolean {
    return (
      error instanceof DeviceControlTransportError &&
      (error.failure.phase === "connect" || !error.failure.sessionValid)
    );
  }

  private async resetConnection(): Promise<void> {
    const shutdownDisconnectResolve = this.resolveDaemonShutdownDisconnect;
    const staleClient = this.client;
    this.resourceSubscriptionSync = Promise.resolve();
    this.connected = false;
    this.client = null;
    this.structuredSessionNotFound = false;
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = null;
    this.invalidateCache();

    if (!staleClient) {
      this.completeDaemonShutdownDisconnect(shutdownDisconnectResolve);
      return;
    }

    try {
      await staleClient.close();
    } catch (error) {
      logger.warn(`[DaemonMcpProxy] Failed to close stale daemon client: ${error}`);
    }
    // resetConnection deliberately unregisters the peer-close callback before
    // closing the stale client. Resolve an armed shutdown barrier explicitly so
    // the retry cannot wait forever for a callback that can no longer fire.
    this.completeDaemonShutdownDisconnect(shutdownDisconnectResolve);
  }

  private subscribeToClientConnectionClosed(client: DaemonClientLike): void {
    if (typeof client.onConnectionClosed !== "function") {
      return;
    }
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = client.onConnectionClosed(() => {
      if (this.client === client) {
        // EOF is the only connection-wide shutdown signal an idle proxy receives,
        // and a subscribed release notification can be lost while the old socket
        // drains. Arm the same successor barrier before reset detaches this client.
        this.waitForDaemonShutdownDisconnect();
        this.completeDaemonShutdownDisconnect();
        void this.resetConnection().then(() => this.connectResourceSubscriptionsInBackground());
      }
    });
  }

  /**
   * Serve the tool surface for a client `tools/list` request.
   *
   * When no daemon connection exists yet, this returns the static tool surface
   * (`schemas/tool-definitions.json`) WITHOUT connecting or starting the daemon,
   * and defers the daemon connect/start to the first actual tool call (issue
   * #5879). A wedged or absent daemon therefore never hides the tool surface at
   * `tools/list` time; the client still gets one clear error on first use.
   *
   * Once a connection is established, this returns the daemon's live,
   * session-scoped list for this connection. The static superset is used only
   * for the cold bootstrap above and if the live list fails below. Connection-
   * profile updates and session binding can transiently narrow the live
   * `tools/list` response; the explicit tools `list_changed` notifications and
   * cache invalidation for those updates prompt clients to re-fetch under the
   * current scope, so a stale-superset merge is not needed for completeness.
   *
   * The static path deliberately does NOT call `throwIfBoundSessionUnavailable()`
   * (unlike {@link listTools}): re-coupling `tools/list` to daemon/session state
   * is exactly what issue #5879 removes. A fenced/expired bound session still
   * surfaces its ownership-lost error on the next actual tool call, which routes
   * through {@link callTool}'s gate.
   */
  async listAdvertisedTools(): Promise<ProxiedToolDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.cachedTools ?? this.staticToolDefinitionsProvider();
    }
    if (!this.connected || !this.client) {
      this.servedStaticToolList = true;
      return this.staticToolDefinitionsProvider();
    }
    // The live per-connection list is the post-connect contract (#5879); the
    // static fallback is only built when the live call fails, so its cost — a
    // reconciliationStatus() + connectedFallbackDaemonOptions() ide/status RPC —
    // stays off the success path (and can't fail a list whose live call would
    // have succeeded, e.g. daemonManager.status() throwing during a restart).
    try {
      const tools = await this.listTools();
      this.connectedFallbackReconcileAttempt = 0;
      return tools;
    } catch (error) {
      if (
        error instanceof DaemonBoundSessionExpiredError ||
        error instanceof DaemonConnectionSessionReleasedError ||
        error instanceof DeviceControlTransportError ||
        error instanceof McpOverloadError
      ) {
        throw error;
      }
      logger.warn(
        `[DaemonMcpProxy] Live tools/list failed; serving connected static fallback: ${errorMessage(error)}`,
        error,
      );
      this.scheduleConnectedFallbackReconcile();
      const daemonStatus = await this.reconciliationStatus();
      const fallbackOptions = await this.connectedFallbackDaemonOptions(daemonStatus);
      return this.connectedStaticToolDefinitionsProvider(fallbackOptions);
    }
  }

  private async connectedFallbackDaemonOptions(daemonStatus: DaemonStatus): Promise<DaemonOptions> {
    return {
      ...daemonStatus.options,
      debug: daemonStatus.effectiveDebug ?? daemonStatus.options?.debug,
    };
  }

  /**
   * Serve a client `resources/list` request without connecting when no daemon
   * connection exists yet (issue #5879 review). AutoMobile resources are dynamic
   * and daemon-owned (device-session screenshots, per-app navigation graphs), so
   * there is no static cold surface — the cold roster is whatever a prior
   * connection cached, else empty. Deferring the connect keeps a host that
   * enumerates resources during initialization from blocking on a wedged daemon
   * before the first tool call. The first successful connect after a cold serve
   * emits a resources `list_changed` (see {@link doConnect}) so the client
   * re-fetches the real resources.
   */
  async listAdvertisedResources(): Promise<ProxiedResourceDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.cachedResources ?? [];
    }
    if (this.connected && this.client) {
      return this.listResources();
    }
    this.serveResourcesColdAndConnectInBackground();
    return this.cachedResources ?? [];
  }

  /**
   * Serve a client `resources/templates/list` request without connecting when no
   * daemon connection exists yet. See {@link listAdvertisedResources}.
   */
  async listAdvertisedResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.cachedResourceTemplates ?? [];
    }
    if (this.connected && this.client) {
      return this.listResourceTemplates();
    }
    this.serveResourcesColdAndConnectInBackground();
    return this.cachedResourceTemplates ?? [];
  }

  // Resource discovery has no "first use that connects" equivalent — a
  // resource-only client may list resources and never call a tool, so nothing
  // would ever establish the connection that populates its daemon-owned
  // resources (e.g. `automobile:devices/booted`). Kick off a NON-BLOCKING
  // background connect so the daemon connects and the reconciliation
  // `resources/list_changed` fires, WITHOUT blocking this cold discovery
  // response (issue #5879 review). The `connecting` guard in ensureConnected()
  // dedupes concurrent/polled calls, so at most one attempt is in flight.
  private serveResourcesColdAndConnectInBackground(): void {
    this.servedStaticResourceList = true;
    this.connectResourcesInBackground();
  }

  private connectResourceSubscriptionsInBackground(): void {
    if (this.resourceSubscriptions.size > 0 && !this.connected) {
      this.connectResourcesInBackground();
    }
  }

  private connectResourcesInBackground(): void {
    if (this.connecting || this.backgroundConnectRetry || this.closing) {
      return;
    }
    void this.ensureBackgroundResourceConnection();
  }

  private async ensureBackgroundResourceConnection(): Promise<void> {
    if (!this.servedStaticResourceList && this.resourceSubscriptions.size === 0) {
      return;
    }
    try {
      await this.ensureConnected();
    } catch (error) {
      // Best-effort: the cold roster already returned, and the tool surface is
      // visible via tools/list. A wedged/absent daemon must not surface here; the
      // the next actual request still reports the failure to the client. Retry
      // transient failures a bounded number of times for resource-only clients.
      logger.warn("[DaemonMcpProxy] background resource connect failed", error);
      this.scheduleBackgroundConnectRetry();
    }
  }

  private scheduleBackgroundConnectRetry(): void {
    if (this.closing || this.connected || this.backgroundConnectRetry) {
      return;
    }
    const delay = COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS[this.backgroundConnectRetryAttempt];
    if (delay === undefined) {
      return;
    }
    this.backgroundConnectRetryAttempt += 1;
    this.backgroundConnectRetry = this.timer.setTimeout(() => {
      this.backgroundConnectRetry = null;
      void this.ensureBackgroundResourceConnection();
    }, delay);
  }

  private cancelBackgroundConnectRetry(): void {
    if (this.backgroundConnectRetry) {
      this.timer.clearTimeout(this.backgroundConnectRetry);
      this.backgroundConnectRetry = null;
    }
    this.backgroundConnectRetryAttempt = 0;
  }

  private scheduleConnectedFallbackReconcile(replacingAttempt = false): void {
    const delay = COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS[this.connectedFallbackReconcileAttempt];
    if (this.closing || !this.connected || delay === undefined) {
      if (replacingAttempt) {
        this.connectedFallbackReconcile = null;
        if (!this.closing && !this.connected) {
          this.servedStaticToolList = true;
        }
      }
      return;
    }
    if (this.connectedFallbackReconcile && !replacingAttempt) {
      return;
    }
    this.connectedFallbackReconcileAttempt += 1;
    this.connectedFallbackReconcile = this.timer.setTimeout(() => {
      void this.attemptConnectedFallbackReconcile();
    }, delay);
  }

  private async attemptConnectedFallbackReconcile(): Promise<void> {
    if (this.closing || !this.connected) {
      this.connectedFallbackReconcile = null;
      if (!this.closing) {
        this.servedStaticToolList = true;
      }
      return;
    }
    this.invalidateListCache("tools");
    try {
      await this.listTools();
      this.connectedFallbackReconcileAttempt = 0;
      this.connectedFallbackReconcile = null;
      this.notifyListChanged("tools");
    } catch (error) {
      // Best-effort: callable static schemas were already returned, and the
      // bounded retry can safely wait for the daemon's live list to recover.
      logger.debug(
        `[DaemonMcpProxy] connected static fallback reconciliation failed: ${errorMessage(error)}`,
      );
      this.scheduleConnectedFallbackReconcile(true);
    }
  }

  private cancelConnectedFallbackReconcile(): void {
    if (this.connectedFallbackReconcile) {
      this.timer.clearTimeout(this.connectedFallbackReconcile);
      this.connectedFallbackReconcile = null;
    }
    this.connectedFallbackReconcileAttempt = 0;
  }

  /**
   * Get list of available tools from daemon
   */
  async listTools(): Promise<ProxiedToolDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.listDuringLivenessFence(
        () => this.fetchTools(true),
        () => this.cachedTools ?? this.staticToolDefinitionsProvider(),
      );
    }
    return this.fetchTools(this.discoveryAfterResultMintRelease());
  }

  private async fetchTools(releasedResultMint: boolean): Promise<ProxiedToolDefinition[]> {
    // Return cached tools if available
    if (this.cachedTools) {
      return this.cachedTools;
    }

    try {
      // Bind discovery to the session like callTool does. Without this, a
      // recoverable reconnect INSIDE withRecoverableReconnect retries tools/list
      // with empty params against the fresh UNSEEDED transport, which returns the
      // full unfiltered tool list instead of the session-scoped one. Reusing the
      // session-scoped params re-seeds the retry after a reconnect (issue #4610).
      // After a result-minted session is released there is no session to bind:
      // the connection is unbound and lists the surface that contains the
      // getAndroid/getApple recovery tools (#9997).
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = this.withToolSelectionProfile(
        releasedResultMint ? {} : this.withBoundSessionUuid({}),
      );
      const result = await this.withRecoverableReconnect(
        () =>
          this.requireClient().callDaemonMethod(
            "tools/list",
            this.withToolSelectionProfile(forwardedParams),
          ),
        this.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const tools = result?.tools ?? [];
      // If a list_changed or bound-session release invalidated this cache WHILE the
      // response was in flight, the response is scoped to the now-stale binding.
      // Return it to THIS caller but leave the cache empty so the next listTools()
      // refetches under the current scope, instead of resurrecting the list the
      // invalidation just cleared (issue #4655).
      // The unbound list served after a result-minted release is not cached
      // (like resources below): a later explicit-sessionUuid call can re-bind a
      // surviving session without a cache invalidation, which would otherwise
      // keep serving this unbound list under the new binding.
      if (this.discoveryEpoch === discoveryEpoch && !releasedResultMint) {
        this.cachedTools = tools;
      }
      return tools;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list tools: ${error}`);
      throw error;
    }
  }

  /**
   * Seed only with the persisted CLI tool-selection profile file's connection-profile UUID.
   * Never pass a device-session UUID: this value is forwarded on every later tool call.
   */
  setToolSelectionProfileUuid(profileUuid: string | undefined): void {
    this.toolSelectionProfileUuid = profileUuid;
  }

  /**
   * Call a tool on the daemon. `progressToken` echoes the external MCP
   * client's own `params._meta.progressToken` (issue #6205); when present it
   * is forwarded to the daemon so `notifications/progress` ticks relayed back
   * over the socket can be routed to `onProgress`, tagged with that SAME
   * token. Omit both to request no progress relay — nothing is fabricated.
   *
   * A call the daemon refuses because a session this proxy holds is suspect is forwarded once
   * more after the liveness recovery the refusal starts has settled, so the client gets that
   * call's result, or the handover/loss error recovery left behind, instead of the refusal.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    progressToken?: string | number,
    onProgress?: DaemonProxyProgressCallback,
    signal?: AbortSignal,
  ): Promise<any> {
    const first = await this.forwardToolCall(name, args, progressToken, onProgress, signal, true);
    const refusal = first.retryableSuspectRefusal;
    if (!refusal || !(await this.awaitSuspectSessionRecovery(refusal, signal))) {
      return first.result;
    }
    // Exactly one retry: the refused call never reached its handler (isSuspectRefusalRetryable).
    // The retry's own pre-forward checks surface a handover or loss recovery recorded.
    logger.info(`[DaemonMcpProxy] Session ${refusal.sessionUuid} restored; retrying ${name} once`);
    const retried = await this.forwardToolCall(
      name,
      args,
      progressToken,
      onProgress,
      signal,
      false,
    );
    return retried.result;
  }

  /**
   * Wait for the recovery a suspect refusal started, bounded by the time the daemon keeps the
   * session reserved plus one heartbeat request. True when the session is held and no longer
   * recovering, so the refused call may be forwarded once more; an abort rejects.
   */
  private async awaitSuspectSessionRecovery(
    refusal: DeviceSessionSuspectRefusal,
    signal: AbortSignal | undefined,
  ): Promise<boolean> {
    const timeoutMs = Math.max(0, refusal.remainingMs) + this.heartbeatRequestTimeoutMs();
    try {
      await raceWithDeadline(this.livenessRecovery.settled(), {
        timer: this.timer,
        timeoutMs,
        signal,
        label: "Suspect session recovery",
      });
    } catch (error) {
      signal?.throwIfAborted();
      // Another session's recovery can outlast the bound; this session's own state decides below.
      logger.warn(
        `[DaemonMcpProxy] Liveness recovery did not settle within ${timeoutMs}ms after session ${refusal.sessionUuid} was refused as suspect`,
        error,
      );
    }
    return !this.closing && !this.livenessRecovery.isRecovering(refusal.sessionUuid);
  }

  private async forwardToolCall(
    name: string,
    args: Record<string, unknown>,
    progressToken: string | number | undefined,
    onProgress: DaemonProxyProgressCallback | undefined,
    signal: AbortSignal | undefined,
    allowSuspectRetry: boolean,
  ): Promise<ForwardedToolCall> {
    signal?.throwIfAborted();
    // These are daemon-internal routing markers. Never accept caller-controlled
    // values: only this proxy may add them after selecting its active binding.
    const callerArgs = { ...args };
    delete callerArgs[DAEMON_BOUND_SESSION_PARAM];
    delete callerArgs[DAEMON_OWNED_SESSIONS_PARAM];
    delete callerArgs[DAEMON_RELEASED_SESSION_PARAM];
    delete callerArgs[DAEMON_TOOL_SELECTION_PROFILE_PARAM];
    delete callerArgs[INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM];
    delete callerArgs[INTERNAL_ACTIONS_COMPACT_METADATA_PARAM];
    // The acceptance controls are configuration of the dedicated harness proxy,
    // never client-provided tool arguments. Remove both before routing so a
    // caller cannot forge or override that configuration.
    delete callerArgs[INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM];
    delete callerArgs[INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM];
    if (this.hasLivenessLifecycleFence()) {
      await this.waitForLivenessRecovery(signal);
    }
    this.reportToolSessionLoss(name, callerArgs);
    if (this.stallHandovers.size > 0) {
      await this.reportStalledSessionNamedBy(callerArgs);
    }
    // Device-session acquisition (including booted provisionDevice) mints a NEW
    // session in its RESULT and is never routed to — or fenced by — the connection's
    // bound session: it must be admitted even on a terminally fenced connection so
    // the client can recover in-band (issue #5689). Forward its raw args and bind
    // the minted session from the result afterwards.
    const isSessionAcquisition = isDeviceSessionAcquisitionTool(name);
    // An omitted `sessionUuid` on the control tool means the connection profile,
    // not the proxy's retained device-routing session. Preserve that distinction
    // after a device has been bound.
    const { forwardedArgs: routedArgs, allowReleasedSession } = this.prepareToolRoutingArgs(
      name,
      callerArgs,
      isSessionAcquisition,
    );
    const forwardedArgs = this.withAcceptanceConfiguration(routedArgs);
    const forwardedSessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    this.retainReleaseEpochReference(forwardedSessionUuid);
    // Snapshot the release epoch at forward time. If a session-released signal for
    // the SPECIFIC forwarded UUID lands WHILE this call is in flight, that UUID's
    // recorded epoch advances past this snapshot and the completion path below
    // declines to resurrect the released UUID (issue #4611/#4655). A release of an
    // UNRELATED session bumps the global epoch but not the forwarded UUID's entry,
    // so it does not block remembering the session this call forwarded.
    const callReleaseEpoch = this.releaseEpoch;
    const learnsResultSession = ["setActiveDevice", ...DEVICE_SESSION_ACQUISITION_TOOLS].includes(
      name,
    );
    this.retainAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch);
    let registeredRequestId: string | undefined;
    let registeredClient: DaemonClientLike | undefined;
    try {
      const forwarding = this.withRecoverableReconnect(
        () => {
          signal?.throwIfAborted();
          this.throwIfForwardedSessionReleasedSince(forwardedArgs, callReleaseEpoch);
          const client = this.requireClient();
          return this.trackToolCallInFlight(client, () =>
            client.callTool(
              name,
              this.withToolSelectionProfile(forwardedArgs),
              progressToken,
              (requestId) => {
                this.removeProgressListener(registeredClient, registeredRequestId);
                registeredClient = client;
                registeredRequestId = requestId;
                if (progressToken !== undefined && onProgress) {
                  let listeners = this.progressListeners.get(client);
                  if (!listeners) {
                    listeners = new Map();
                    this.progressListeners.set(client, listeners);
                  }
                  listeners.set(requestId, { progressToken, listener: onProgress });
                }
              },
              signal,
            ),
          );
        },
        forwardedSessionUuid,
        // Acquisition is admitted while fenced; the terminal fence is cleared once
        // the result-minted session establishes a fresh binding.
        allowReleasedSession,
        true,
        nonIdempotentToolName(name),
        signal,
      );
      // Connection recovery is shared with siblings; cancel this wait and fence
      // replay without aborting the shared connection attempt.
      const result = await raceWithDeadline(forwarding, {
        timer: this.timer,
        signal,
        label: `Daemon tool ${name}`,
      });
      if (result?.isError) {
        // Provisioning retains its usable device session when optional resource
        // configuration fails. Own that result-minted session before returning
        // the evidence-bearing error, so the caller can inspect or retry it.
        if (name === "provisionDevice") {
          await this.bindResultMintedDeviceSession(name, result, callReleaseEpoch);
        }
        const retryableSuspectRefusal = this.noteSuspectSessionResult(
          name,
          result,
          forwardedArgs,
          allowSuspectRetry,
        );
        this.bindForwardedSessionOnErrorResult(name, forwardedArgs, result, callReleaseEpoch);
        return { result, retryableSuspectRefusal };
      }
      this.rememberToolSelectionProfile(name, callerArgs, result);
      if (isSessionAcquisition) {
        await this.bindResultMintedDeviceSession(name, result, callReleaseEpoch);
        return { result };
      }
      // Remember what was actually forwarded, not the caller's raw args. An
      // implicit sessionless call injects the bound UUID into forwardedArgs and
      // extends the live daemon session in getOrCreateSession(); refreshing the
      // replay lease off forwardedArgs keeps continuous implicit activity from
      // being mistaken for idleness, so a later reconnect re-seeds the still-live
      // session instead of creating an unseeded transport (issue #4610).
      this.rememberSessionUuid(name, forwardedArgs, callReleaseEpoch);
      this.rememberActiveDeviceSession(name, result, callReleaseEpoch);
      return { result };
    } catch (error) {
      signal?.throwIfAborted();
      // The success-only rememberSessionUuid above never runs when the handler
      // rejects, but an admitted-then-rejected call still reached
      // getOrCreateSession() and refreshed the LIVE daemon session. Without
      // refreshing the replay lease here too, repeated admitted-but-failed calls
      // let the proxy lease silently expire while the daemon session stays alive,
      // so a later reconnect can no longer replay it (issue #4610).
      this.refreshReplayLeaseAfterAdmittedFailure(name, forwardedArgs, error, callReleaseEpoch);
      // Do NOT clear the binding on a rejected executePlan. A plan can reject
      // *before* the handler runs — tool-selection enforcement or schema parsing in
      // src/server/index.ts — in which case DefaultPlanLifecycleManager
      // .afterExecution() never runs and the daemon session stays LIVE. Forgetting
      // it here would strand a still-live session after a reconnect. The binding is
      // now cleared authoritatively by the daemon's session-released signal
      // (handleDaemonNotification) whenever the session is *actually* released —
      // whether the plan succeeded or failed inside the handler (issue #4610).
      // withRecoverableReconnect already reconciled build identity and retried once.
      // A still-"Unknown tool" failure means the daemon genuinely cannot provide a
      // tool this frontend advertises — surface an actionable error naming both
      // builds instead of the opaque -32603.
      if (this.isUnknownToolError(error)) {
        throw await this.toolUnavailableError(
          name,
          errorMessage(error),
          this.isGatedToolError(error),
        );
      }
      throw error;
    } finally {
      this.releaseReleaseEpochReference(forwardedSessionUuid);
      this.releaseAcquisitionReleaseEpoch(learnsResultSession, callReleaseEpoch);
      this.removeProgressListener(registeredClient, registeredRequestId);
    }
  }

  private withAcceptanceConfiguration(args: Record<string, unknown>): Record<string, unknown> {
    const acceptanceDiscovery = this.config.acceptanceDiscovery;
    if (!acceptanceDiscovery) {
      return args;
    }
    return {
      ...args,
      [INTERNAL_ACCEPTANCE_DISCOVERY_ORDER_PARAM]: acceptanceDiscovery.order,
      [INTERNAL_ACCEPTANCE_DISCOVERY_CAPABILITY_PARAM]: acceptanceDiscovery.capability,
    };
  }

  private prepareToolRoutingArgs(
    name: string,
    callerArgs: Record<string, unknown>,
    isSessionAcquisition: boolean,
  ): { forwardedArgs: Record<string, unknown>; allowReleasedSession: boolean } {
    const isTerminalSessionlessDiscovery =
      this.terminalBoundSession !== undefined &&
      this.sessionUuidFromArgs(callerArgs) === undefined &&
      isDeviceInventoryTool(name);
    const usesDeviceSelector =
      this.toolTargetsDevice(name) &&
      this.hasImplicitDeviceSelector(callerArgs, name === "setActiveDevice");
    const routingArgs =
      name === SET_TOOL_ENABLED_TOOL_NAME
        ? this.withAcquiredDeviceRoute(callerArgs)
        : isSessionAcquisition || isTerminalSessionlessDiscovery
          ? callerArgs
          : this.withBoundSessionUuid(callerArgs, usesDeviceSelector);
    const canUseSurvivingSession = this.canUseSurvivingSession(callerArgs, usesDeviceSelector);
    const forwardedArgs = this.withToolSelectionProfile(
      this.withOwnedSessionCapabilities(routingArgs, usesDeviceSelector || isSessionAcquisition),
    );
    return {
      forwardedArgs,
      allowReleasedSession:
        isSessionAcquisition || isTerminalSessionlessDiscovery || canUseSurvivingSession,
    };
  }

  private toolTargetsDevice(name: string): boolean {
    if (name === "setActiveDevice") {
      return true;
    }
    const schema =
      this.cachedTools?.find((definition) => definition.name === name)?.inputSchema ??
      this.staticToolDefinitionsProvider().find((definition) => definition.name === name)
        ?.inputSchema;
    // Device-targeting schemas expose the device-label contract. Plain
    // platform filters do not have it and must retain their session policy.
    return (
      typeof schema?.properties === "object" &&
      schema.properties !== null &&
      "device" in schema.properties
    );
  }

  private withOwnedSessionCapabilities(
    args: Record<string, unknown>,
    restore: boolean,
  ): Record<string, unknown> {
    if (!restore || this.sessionUuidFromArgs(args)) {
      return args;
    }
    const retained = [...this.ownedDeviceSessions].filter(
      (id) => id !== this.terminalBoundSession?.sessionUuid && id !== this.boundSessionUuid,
    );
    if (this.boundSessionUuid && this.boundSessionUuid !== this.recoverableBoundSessionHandoff) {
      // Restoration uses the first "if-absent" attachment as the fresh socket's
      // default, so the current binding must precede older owned sessions.
      retained.unshift(this.boundSessionUuid);
    }
    return retained.length ? { ...args, [DAEMON_OWNED_SESSIONS_PARAM]: retained } : args;
  }

  private rememberActiveDeviceSession(name: string, result: unknown, releaseEpoch: number): void {
    if (name !== "setActiveDevice") {
      return;
    }
    const sessionUuid = getDeviceSessionIdFromResult(result);
    if (sessionUuid) {
      this.throwIfSessionReleasedSince(sessionUuid, releaseEpoch);
      this.rememberSessionUuid(
        name,
        { sessionUuid, deviceId: getDeviceIdFromResult(result) },
        releaseEpoch,
      );
    }
  }

  private hasImplicitDeviceSelector(
    args: Record<string, unknown>,
    selectingActiveDevice: boolean,
  ): boolean {
    if (this.initialSessionBindingConfigured || args.device) {
      return false;
    }
    if (selectingActiveDevice) {
      return true;
    }
    return (
      typeof args.deviceId === "string" || args.platform === "android" || args.platform === "ios"
    );
  }

  private withBoundSessionUuid(
    args: Record<string, unknown>,
    usesDeviceSelector = false,
  ): Record<string, unknown> {
    // A daemon session released by ordinary heartbeat/idle expiry leaves this
    // remembered binding dangling; replaying its UUID on a later sessionless call
    // would silently recreate the session and reacquire a device without the
    // caller asking for it (issue #4610). Once the replay window has elapsed with
    // no forwarded call (explicit or implicit) refreshing the binding, treat it
    // as retired.
    const explicitSessionUuid = this.sessionUuidFromArgs(args);
    if (!this.canUseSurvivingSession(args, usesDeviceSelector)) {
      this.throwIfBoundSessionUnavailable(explicitSessionUuid);
    }
    const normalizedArgs =
      explicitSessionUuid && explicitSessionUuid !== args.sessionUuid
        ? { ...args, sessionUuid: explicitSessionUuid }
        : args;
    if (!this.boundSessionUuid || explicitSessionUuid === this.boundSessionUuid) {
      return normalizedArgs;
    }
    if (explicitSessionUuid && this.initialSessionBindingConfigured) {
      throw new Error(
        `MCP connection is bound to device session ${this.boundSessionUuid}; ` +
          `cannot route this call to ${explicitSessionUuid} until the binding is released.`,
      );
    }
    if (explicitSessionUuid) {
      return normalizedArgs;
    }
    // A caller's device selector must reach daemon autolock resolution without
    // being disguised as an explicitly supplied session UUID (#6807).
    if (usesDeviceSelector) {
      return normalizedArgs;
    }
    return {
      ...args,
      sessionUuid: this.boundSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid,
    };
  }

  private canUseSurvivingSession(
    args: Record<string, unknown>,
    usesDeviceSelector: boolean,
  ): boolean {
    if (!this.terminalBoundSession || this.config.initialSessionUuid) {
      return false;
    }
    const explicit = this.sessionUuidFromArgs(args);
    const liveOwned = [...this.ownedDeviceSessions].filter(
      (id) => id !== this.terminalBoundSession?.sessionUuid,
    );
    return explicit ? liveOwned.includes(explicit) : liveOwned.length > 0 && usesDeviceSelector;
  }

  private throwIfBoundSessionUnavailable(explicitSessionUuid?: string): void {
    this.throwIfFencedForCaller(explicitSessionUuid);
    if (!this.isBoundSessionReplayExpired()) {
      return;
    }
    this.fenceBoundSessionUuid(this.boundSessionUuid!, "replay-lease-expired");
    this.throwIfFencedForCaller(explicitSessionUuid);
  }

  // Surface a terminal fence to a caller, distinguishing whether the caller
  // referenced the fenced session. A client-declared binding (explicit
  // `sessionUuid`, or the same UUID named again) — or any explicit reference to
  // the fenced UUID — yields the ownership-lost-for-UUID error. A call that never
  // named the session and whose binding was minted by a device-acquisition RESULT
  // instead gets the current connection state, not a stale UUID (issue #5689).
  //
  // This is the entry-gate check for calls arriving at an ALREADY-fenced
  // connection. A session released WHILE a call is actively holding it (the
  // narrow mid-flight-release race) still surfaces the generic ownership-lost
  // error for that UUID via the in-flight fence checks in
  // withRecoverableReconnect — consistent with the established mid-flight-release
  // semantics for every binding — and self-heals: the next call reaches this gate
  // and gets the provenance-aware error.
  private throwIfFencedForCaller(explicitSessionUuid?: string): void {
    const terminal = this.terminalBoundSession;
    if (!terminal) {
      return;
    }
    // A liveness handover (#10053) is always reported: the harness must be told which sessions
    // and devices it lost and what to do, whichever call reaches the fenced binding first.
    const callerReferencedTerminal =
      !terminal.fromResultMint ||
      this.stallHandovers.has(terminal.sessionUuid) ||
      (explicitSessionUuid !== undefined && explicitSessionUuid === terminal.sessionUuid);
    if (callerReferencedTerminal) {
      throw this.boundSessionExpiredError();
    }
    throw new DaemonConnectionSessionReleasedError(terminal.reason);
  }

  private sessionUuidFromArgs(args: Record<string, unknown>): string | undefined {
    return typeof args.sessionUuid === "string" && args.sessionUuid.trim().length > 0
      ? args.sessionUuid.trim()
      : undefined;
  }

  /**
   * A `setToolEnabled` that reaffirms THIS connection's profile keeps that
   * profile as its routing session, but the daemon would otherwise seed the
   * loopback it lands on with the profile as a DEVICE binding, so the update's
   * readback enumerated labels from the profile (none) instead of from the
   * device session this connection acquired. Carry the acquired device route
   * separately so the daemon seeds the loopback with it (#7005). A profile
   * update on a connection with no live device carries nothing extra.
   */
  private withAcquiredDeviceRoute(args: Record<string, unknown>): Record<string, unknown> {
    const explicitSessionUuid = this.sessionUuidFromArgs(args);
    if (
      !explicitSessionUuid ||
      explicitSessionUuid !== this.toolSelectionProfileUuid ||
      !this.boundSessionUuid ||
      this.boundSessionUuid === explicitSessionUuid ||
      this.terminalBoundSession ||
      this.isBoundSessionReplayExpired()
    ) {
      return args;
    }
    return { ...args, [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid };
  }

  private withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown> {
    if (!this.toolSelectionProfileUuid) {
      return args;
    }
    return {
      ...args,
      [DAEMON_TOOL_SELECTION_PROFILE_PARAM]: this.toolSelectionProfileUuid,
    };
  }

  private rememberToolSelectionProfile(
    name: string,
    requestedArgs: Record<string, unknown>,
    result: unknown,
  ): void {
    if (name !== SET_TOOL_ENABLED_TOOL_NAME) {
      return;
    }
    const explicitSessionUuid =
      typeof requestedArgs.sessionUuid === "string" && requestedArgs.sessionUuid.trim().length > 0
        ? requestedArgs.sessionUuid
        : undefined;
    const responseProfileUuid = toolSelectionProfileUuidFromResponse(result);
    if (!explicitSessionUuid) {
      if (responseProfileUuid) {
        this.toolSelectionProfileUuid = responseProfileUuid;
      }
    } else if (responseProfileUuid === explicitSessionUuid) {
      // toolSelectionProfileUuidFromResponse only returns server-confirmed
      // connection-profile responses. Retain a successful self-reaffirm so
      // withToolSelectionProfile() can attach it to later acquisitions.
      this.toolSelectionProfileUuid = responseProfileUuid;
    }
    // Do not depend solely on the daemon's best-effort list_changed delivery.
    // The successful update has already changed the authoritative tool surface.
    this.notifyListChanged("tools");
  }

  private isBoundSessionReplayExpired(): boolean {
    if (
      this.initialSessionBindingConfigured ||
      this.boundSessionUuid === undefined ||
      this.boundSessionUuidAt === undefined
    ) {
      return false;
    }
    return this.timer.now() - this.boundSessionUuidAt >= DAEMON_BOUND_SESSION_REPLAY_TTL_MS;
  }

  private clearBoundSessionUuid(): void {
    this.boundSessionUuid = undefined;
    this.boundSessionUuidAt = undefined;
    this.initialSessionBindingConfigured = false;
    this.boundSessionFromResultMint = false;
    this.livenessOwnershipClaimSent = false;
    this.latestBindingConflict = undefined;
    this.recoverableBoundSessionHandoff = undefined;
  }

  private fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void {
    const handedOver = reason === DAEMON_STALLED_CODE || reason === PROXY_STALLED_CODE;
    this.dropHeldSession(sessionUuid, handedOver);
    this.forgetSessionLivenessState(sessionUuid, handedOver);
    if (this.terminalBoundSession) {
      if (this.terminalBoundSession.sessionUuid === sessionUuid) {
        if (reason !== "released") {
          this.terminalBoundSession.reason = reason;
        }
        this.terminalBoundSession.release = release ?? this.terminalBoundSession.release;
      }
      return;
    }
    this.terminalBoundSession = {
      sessionUuid,
      reason,
      fromResultMint: this.boundSessionFromResultMint,
      ...(release ? { release } : {}),
    };
    // A terminal release changes the scope of in-flight discovery and prevents
    // its stale response from repopulating a cleared cache.
    this.discoveryEpoch += 1;
    this.invalidateCache();
    this.clearBoundSessionUuid();
    // Other held sessions keep depending on this keeper after the latest binding
    // is fenced, so it only stops once nothing is left to heartbeat (#9335).
    if (this.otherHeldSessions.size === 0) {
      void this.stopBoundSessionHeartbeat();
    }
    // A result-minted binding scoped the tool list the client last fetched; the
    // connection is now unbound, so prompt a re-list (binding does the same).
    // A declared binding's discovery keeps failing, so there is nothing to refresh.
    if (this.terminalBoundSession.fromResultMint) {
      this.notifyListChanged("tools");
    }
  }

  /**
   * Entry gate for tools/list, resources/list and resources/templates/list.
   * Returns true when the only fence is a RESULT-MINTED session that was
   * released: the connection is then unbound and recovers in-band through
   * getAndroid/getApple, so discovery must keep working and list the surface that
   * contains those tools (#9997). A client-declared binding cannot recover on its
   * transport, so its fence still raises the ownership-lost error (#5689).
   */
  private discoveryAfterResultMintRelease(): boolean {
    if (!this.terminalBoundSession && this.isBoundSessionReplayExpired()) {
      this.fenceBoundSessionUuid(this.boundSessionUuid!, "replay-lease-expired");
    }
    const terminal = this.terminalBoundSession;
    if (!terminal) {
      return false;
    }
    if (!terminal.fromResultMint) {
      throw this.boundSessionExpiredError();
    }
    return true;
  }

  private throwIfBoundSessionFenced(allowReleasedSession = false): void {
    if (this.terminalBoundSession && !allowReleasedSession) {
      throw this.boundSessionExpiredError();
    }
  }

  private boundSessionExpiredError(): DaemonBoundSessionExpiredError {
    const terminal = this.terminalBoundSession;
    if (!terminal) {
      throw new Error("Bound session is not terminal");
    }
    const stall = this.stallHandovers.get(terminal.sessionUuid);
    if (stall) {
      stall.delivered = true;
      return new DaemonSessionStalledError(terminal.sessionUuid, stall.handover);
    }
    return new DaemonBoundSessionExpiredError(
      terminal.sessionUuid,
      terminal.reason,
      terminal.release,
    );
  }

  /**
   * The daemon transport is live and usable for a heartbeat. Distinct from the
   * public `connected` flag, which is deferred until AFTER the establishment
   * heartbeat lands so concurrent ensureConnected() callers block on ownership
   * (issue #5643). During that window the client has connected but `connected` is
   * still false; the first-heartbeat / keeper guards must treat the transport as
   * usable. Everywhere else `this.client !== null` tracks `connected` (both are
   * set on connect and cleared together on reset/close), so this only widens the
   * guard across the deliberate establishment window.
   */
  private get transportLive(): boolean {
    return this.client !== null;
  }

  /**
   * The live client for an operation closure. A socket close can land between
   * ensureConnected() resolving and the closure running (#6389); report that as
   * a recoverable DaemonUnavailableError rather than a TypeError on null. No
   * client means no request frame was written, so the failure is typed as not
   * delivered: a non-idempotent tool may then be retried on the reconnected
   * client instead of being reported as outcome-unknown (#9996).
   */
  private requireClient(): DaemonClientLike {
    if (!this.client) {
      throw new DaemonRequestNotDeliveredError("Daemon socket connection is not established");
    }
    return this.client;
  }

  private startBoundSessionHeartbeat(): void {
    if (
      this.boundSessionUuid &&
      !this.terminalBoundSession &&
      // An args-named latest binding is never heartbeated (#10664); the keeper still runs
      // for the sessions this proxy holds besides it.
      (this.latestBindingClaimable() || this.otherHeldSessions.size > 0) &&
      this.transportLive &&
      !this.closing
    ) {
      void this.heartbeatKeeper.run();
      this.heartbeatKeeper.start();
      this.heartbeatKeeperStarted = true;
    }
  }

  /**
   * Deliver the first ownership heartbeat as part of connection establishment for
   * a bound session (issue #5637), then start the recurring keeper.
   *
   * A newly connected client whose session was allocated shortly before startup
   * must reach the daemon with its first heartbeat before the pre-first-heartbeat
   * fast-reclaim (issue #2443) can release it. Awaiting the send here makes the
   * guarantee contractual: once ensureConnected() resolves for a bound session,
   * the daemon has recorded ownership — instead of racing a fire-and-forget
   * dispatch against the reclaim sweep.
   *
   * Only the FIRST establishment sends here: once the keeper is running it owns
   * every subsequent tick, so a later reconnect (which may itself be driven by a
   * keeper tick) defers to the keeper's own coalesced heartbeat rather than
   * emitting a duplicate.
   */
  private async establishBoundSessionHeartbeat(): Promise<void> {
    if (
      !(this.boundSessionUuid && !this.terminalBoundSession && this.transportLive && !this.closing)
    ) {
      return;
    }
    if (this.heartbeatKeeperStarted) {
      // Reconnect/rebind: fall back to the keeper's own coalescing run(). If this
      // reconnect is itself driven by a keeper tick, run() shares that in-flight
      // tick instead of emitting a duplicate; otherwise it sends a fresh heartbeat
      // on the new transport, exactly as before this change.
      //
      // Ownership was already recorded by the first establishment, so — unlike the
      // first-heartbeat path (issue #5643) — there is nothing to hold concurrent
      // callers behind. Mark the transport connected BEFORE dispatching the keeper
      // heartbeat: startBoundSessionHeartbeat void-dispatches run(), which re-enters
      // ensureConnected() and must short-circuit on the fast path so the heartbeat
      // lands on the fresh transport before the retried operation (#2737/#4610
      // ordering). doConnect defers this flip only on the first establishment.
      this.connected = true;
      this.startBoundSessionHeartbeat();
      return;
    }
    if (!this.latestBindingClaimable()) {
      // Only named in a tool call's args: never claimed or heartbeated (#10664).
      return;
    }
    await this.sendFirstBoundSessionHeartbeat();
    // Re-validate after the awaited round-trip: a session-released notification or
    // close() landing mid-send may have terminally fenced this binding and stopped
    // the keeper. Restarting it here would leak a no-op interval and desync
    // heartbeatKeeperStarted from the fenced state. Mirrors startBoundSessionHeartbeat's guard.
    if (
      !(this.boundSessionUuid && !this.terminalBoundSession && this.transportLive && !this.closing)
    ) {
      return;
    }
    // The keeper owns every subsequent tick, its reconnect, and terminal fencing.
    // No immediate run() here: the direct send above already delivered the first
    // heartbeat, and a second would duplicate it.
    // Seed the cadence so even the first keeper tick can be recognised as late (#10053).
    this.tickLateness.note(this.timer.now());
    this.heartbeatKeeper.start();
    this.heartbeatKeeperStarted = true;
  }

  /**
   * Send the establishment heartbeat directly against the freshly connected
   * client. Deliberately NOT routed through withRecoverableReconnect(): that path
   * re-enters ensureConnected(), which is still in flight during establishment and
   * would deadlock on a reconnect. A transient failure is best-effort — the keeper
   * started next retries within the daemon's pre-first-heartbeat grace, and a
   * genuinely released session is fenced by the keeper's reconnect path or a
   * session-released notification.
   */
  private async sendFirstBoundSessionHeartbeat(): Promise<void> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || !this.latestBindingClaimable() || this.closing || !this.client) {
      return;
    }
    try {
      await this.client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        this.boundSessionHeartbeatParams(sessionUuid, true),
      );
      if (this.boundSessionUuid === sessionUuid && !this.terminalBoundSession) {
        this.livenessOwnershipClaimSent = true;
        this.boundSessionUuidAt = this.timer.now();
        this.livenessAcks.set(sessionUuid, this.timer.now());
      }
    } catch (error) {
      if (this.isDaemonSessionNotFoundError(error) && this.boundSessionUuid === sessionUuid) {
        // The bound session was already reaped before our first heartbeat reached
        // the daemon (the #5637 race lost). Surface it as terminal now instead of
        // proceeding to a keeper that can only re-confirm the loss — this keeps
        // terminal fencing intact and gives the caller an ownership-lost error on
        // its next operation. Synchronous fence: no reconnect, no reentrancy.
        this.fenceBoundSessionUuid(sessionUuid, "session-not-found");
        return;
      }
      // Safe to swallow the rest: the establishment heartbeat is best-effort. The
      // keeper started immediately after retries within the pre-first-heartbeat
      // grace — so a transient failure here must not fail connection establishment.
      logger.debug(
        `[DaemonMcpProxy] Initial bound-session heartbeat failed: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Declare this connection's bound device session CLI-owned (issue #6870).
   *
   * A `--cli` invocation is a one-shot process: it connects, runs one tool and
   * exits, so the recurring keeper above dies with it and the daemon reaps the
   * session after the 10 s heartbeat timeout — roughly the time an agent spends
   * reading the previous result. Sending one heartbeat that also carries
   * {@link CLI_SESSION_LIVENESS_POLICY} records ownership AND moves the session
   * onto a wall-clock idle timeout measured in minutes, so the next invocation
   * still finds it. Returns the declared session uuid, or undefined when there
   * was nothing to declare.
   *
   * Long-lived clients (stdio/HTTP MCP) never call this and keep the strict
   * contract: their keeper can hold it.
   */
  async adoptCliSessionLiveness(): Promise<string | undefined> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || this.terminalBoundSession || this.closing || !this.client) {
      return undefined;
    }
    try {
      // A one-shot CLI is leaving, so stop future keeper ticks and wait only a
      // short bounded interval for the current strict-policy heartbeat. This
      // both prevents an older heartbeat from restoring strict policy after
      // the declaration and prevents a completed tool result from being hidden
      // behind a stalled ownership RPC.
      const heartbeatSettled = await this.stopBoundSessionHeartbeat();
      if (!heartbeatSettled) {
        return undefined;
      }
      if (this.boundSessionUuid !== sessionUuid || this.terminalBoundSession || this.closing) {
        return undefined;
      }
      // Declare before the round-trip: a keeper tick that fires while this call
      // is in flight must already carry the CLI marker, or it would land after
      // the declaration and restore the strict contract.
      this.cliSessionLivenessDeclared = true;
      this.livenessOwnershipClaimSent = true;
      await this.client.callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        {
          sessionId: sessionUuid,
          livenessPolicy: CLI_SESSION_LIVENESS_POLICY,
          livenessOwnerToken: this.livenessOwnerToken,
          claimLivenessOwnership: true,
          // The daemon resolved its own env at startup and this invocation reuses
          // it, so the override only reaches the daemon by travelling with the
          // declaration (issue #6870 review). The daemon re-validates and bounds it.
          idleTimeoutMs: getCliSessionIdleTimeoutMs(),
        },
        { timeoutMs: CLI_SESSION_FINALIZATION_TIMEOUT_MS },
      );
      return sessionUuid;
    } catch (error) {
      // Best-effort: the tool call already succeeded and its result is the
      // caller's answer. A failed declaration only means the next invocation may
      // have to re-acquire, which is the pre-#6870 behaviour — never a reason to
      // fail the invocation that just ran.
      logger.debug(
        `[DaemonMcpProxy] CLI session liveness declaration failed: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  private async stopBoundSessionHeartbeat(): Promise<boolean> {
    const settled = await this.heartbeatKeeper.stop();
    this.heartbeatKeeperStarted = false;
    // A later start is a fresh cadence, not a late tick.
    this.tickLateness.reset();
    if (!settled) {
      logger.warn("[DaemonMcpProxy] Bound-session heartbeat did not settle before shutdown");
    }
    return settled;
  }

  /**
   * Parameters for an ordinary (non-declaring) bound-session heartbeat.
   *
   * A long-lived stdio/HTTP proxy declares `heartbeat` so the daemon restores
   * the strict contract on a session a previous `--cli` invocation widened
   * (issue #6870 review). Once THIS proxy has declared the session CLI-owned,
   * its own remaining heartbeats keep the CLI marker instead, so a keeper tick
   * racing process exit cannot undo the declaration.
   */
  private boundSessionHeartbeatParams(
    sessionUuid: string,
    claimLivenessOwnership = false,
  ): {
    sessionId: string;
    livenessPolicy: string;
    idleTimeoutMs?: number;
    livenessOwnerToken: string;
    claimLivenessOwnership?: true;
  } {
    const livenessPolicy = this.cliSessionLivenessDeclared
      ? CLI_SESSION_LIVENESS_POLICY
      : HEARTBEAT_SESSION_LIVENESS_POLICY;
    return {
      sessionId: sessionUuid,
      livenessPolicy,
      ...(livenessPolicy === CLI_SESSION_LIVENESS_POLICY
        ? { idleTimeoutMs: getCliSessionIdleTimeoutMs() }
        : {}),
      livenessOwnerToken: this.livenessOwnerToken,
      ...(claimLivenessOwnership ? { claimLivenessOwnership: true } : {}),
    };
  }

  private async runBoundSessionHeartbeatTick(): Promise<void> {
    if (this.tickLateness.note(this.timer.now()) > this.heartbeatLeashMs) {
      this.beginProxyStallRecovery();
    }
    if (this.otherHeldSessions.size === 0) {
      await this.runLatestBindingHeartbeatTick();
      return;
    }
    // Each held session is isolated: a failure of one never skips the others,
    // and the latest binding's own failure semantics are preserved.
    const [latestBinding] = await Promise.allSettled([
      this.runLatestBindingHeartbeatTick(),
      this.heartbeatOtherHeldSessions(),
    ]);
    if (latestBinding.status === "rejected") {
      throw latestBinding.reason;
    }
  }

  /**
   * This proxy's own tick fired later than the lease allows, so its sessions' leases may have
   * lapsed while it could not heartbeat (#10053). Every session it holds is re-heartbeated with the
   * same owner token: one the daemon kept as suspect is restored with the same UUID, one it already
   * released is reported in the `proxy_stalled` handover.
   */
  private beginProxyStallRecovery(): void {
    logger.warn(
      `[DaemonMcpProxy] Heartbeat tick fired more than ${this.heartbeatLeashMs}ms late; re-heartbeating held sessions`,
    );
    for (const sessionUuid of this.heldSessionUuids()) {
      this.livenessRecovery.begin(sessionUuid, PROXY_STALLED_CODE);
    }
  }

  /** Every session this proxy heartbeats: the latest binding plus the ones it still holds. */
  private heldSessionUuids(): string[] {
    const latest = this.latestBindingClaimable() ? [this.boundSessionUuid!] : [];
    return [...latest, ...this.otherHeldSessions.keys()];
  }

  /**
   * Whether the latest binding is one this proxy claims and heartbeats: live, and minted by this
   * proxy or configured at startup, never merely named in a tool call's args (#10664).
   */
  private latestBindingClaimable(): boolean {
    return (
      this.boundSessionUuid !== undefined &&
      !this.terminalBoundSession &&
      this.claimableSessions.has(this.boundSessionUuid)
    );
  }

  private createLivenessRecovery(): LivenessRecovery {
    return new LivenessRecovery({
      timer: this.timer,
      leaseMs: this.heartbeatLeashMs,
      requestTimeoutMs: this.heartbeatRequestTimeoutMs(),
      lastAckAt: (sessionUuid) => this.livenessAckedAt(sessionUuid),
      hasAcknowledgedSince: (sessionUuid, sinceMs) =>
        (this.livenessAcks.get(sessionUuid) ?? Number.NEGATIVE_INFINITY) > sinceMs,
      deviceIdOf: (sessionUuid) => this.sessionDeviceIds.get(sessionUuid),
      isActive: (sessionUuid) => !this.closing && this.isHeldSession(sessionUuid),
      attempt: (sessionUuid, attemptNumber, _deadlineMs, claimSocketReset) =>
        this.runRecoveryAttempt(sessionUuid, attemptNumber, claimSocketReset),
      onRecovered: ({ sessionUuid, code, attempts, restoredAfterLapse }) => {
        logger.info(
          `[DaemonMcpProxy] Recovered ${code} for session ${sessionUuid} after ${attempts} attempt(s)` +
            (restoredAfterLapse ? "; the daemon held it as suspect and kept the same UUID" : ""),
        );
      },
      onSessionGone: (sessionUuid) => this.dropGoneSession(sessionUuid),
      onHandover: (handover) => this.deliverLivenessHandover(handover),
    });
  }

  private isHeldSession(sessionUuid: string): boolean {
    return (
      (sessionUuid === this.boundSessionUuid && this.latestBindingClaimable()) ||
      this.otherHeldSessions.has(sessionUuid)
    );
  }

  /** When the daemon last acknowledged this session's heartbeat, falling back to when it was bound. */
  private livenessAckedAt(sessionUuid: string): number {
    return (
      this.livenessAcks.get(sessionUuid) ??
      (sessionUuid === this.boundSessionUuid ? this.boundSessionUuidAt : undefined) ??
      this.timer.now()
    );
  }

  /** How long a heartbeat is given before it counts as unanswered. */
  private heartbeatRequestTimeoutMs(): number {
    return heartbeatRequestTimeoutMs(this.heartbeatLeashMs, this.heartbeatIntervalMs);
  }

  /**
   * One recovery attempt: reconnect if needed and re-heartbeat with the same owner token. The
   * connection is observation-only, so an unreachable daemon fails the attempt; this proxy never
   * starts, restarts or stops it.
   */
  private async runRecoveryAttempt(
    sessionUuid: string,
    attemptNumber: number,
    claimSocketReset: () => boolean,
  ): Promise<RecoveryAttemptOutcome> {
    const claimLivenessOwnership = this.livenessClaimPending(sessionUuid);
    let attemptedClient: DaemonClientLike | null = null;
    try {
      await runWithoutDaemonLifecycle(async () => {
        if (this.shouldReplaceSocketForRecovery(attemptNumber, claimSocketReset)) {
          await this.resetConnection();
        }
        await this.ensureConnected();
        attemptedClient = this.requireClient();
        await attemptedClient.callDaemonMethod(
          DAEMON_HEARTBEAT_METHOD,
          this.boundSessionHeartbeatParams(sessionUuid, claimLivenessOwnership),
        );
      });
    } catch (error) {
      if (attemptedClient && error instanceof DaemonUnavailableError) {
        this.deadSocketClients.add(attemptedClient);
      }
      return this.classifyRecoveryAttemptError(sessionUuid, attemptNumber, error);
    }
    this.recordRecoveryAcknowledgement(sessionUuid, claimLivenessOwnership);
    return "acknowledged";
  }

  /**
   * Whether this attempt may replace the daemon socket. It is one connection shared by every
   * session this proxy holds and by tool calls in flight, so replacing it rejects all of their
   * requests. From the second attempt a socket that is open but silent has already failed to carry
   * a heartbeat, so it is replaced, but at most once per recovery episode (not per session) and
   * never beneath a tool call in flight unless the socket is already proven dead by a transport
   * failure, when there is nothing left to lose.
   */
  private shouldReplaceSocketForRecovery(
    attemptNumber: number,
    claimSocketReset: () => boolean,
  ): boolean {
    const client = this.client;
    if (attemptNumber <= 1 || !client) {
      return false;
    }
    if (this.deadSocketClients.has(client)) {
      return true;
    }
    if ((this.toolCallsInFlight.get(client) ?? 0) > 0) {
      return false;
    }
    return claimSocketReset();
  }

  /**
   * Count a tool call on `client` while it awaits an answer. The caller gets the call's own
   * promise back, not a wrapper, so tracking adds no scheduling turns to the forwarding path.
   */
  private trackToolCallInFlight<T>(client: DaemonClientLike, send: () => Promise<T>): Promise<T> {
    const settle = () =>
      this.toolCallsInFlight.set(
        client,
        Math.max(0, (this.toolCallsInFlight.get(client) ?? 1) - 1),
      );
    this.toolCallsInFlight.set(client, (this.toolCallsInFlight.get(client) ?? 0) + 1);
    let forwarded: Promise<T>;
    try {
      forwarded = send();
    } catch (error) {
      settle();
      throw error;
    }
    forwarded.then(settle, settle);
    return forwarded;
  }

  private classifyRecoveryAttemptError(
    sessionUuid: string,
    attemptNumber: number,
    error: unknown,
  ): RecoveryAttemptOutcome {
    if (this.isDaemonSessionNotFoundError(error)) {
      return "session-gone";
    }
    if (isLivenessOwnershipLostError(error)) {
      // Another token took the session over while this proxy could not heartbeat it.
      return "superseded";
    }
    if (!this.isMissingHeartbeatAcknowledgement(error)) {
      // The daemon answered with a conflict refusal: it is reachable, and the regular tick's
      // own conflict handling takes it from here.
      return "acknowledged";
    }
    logger.warn(
      `[DaemonMcpProxy] Recovery attempt ${attemptNumber} for session ${sessionUuid} failed: ${errorMessage(error)}`,
    );
    return "unreachable";
  }

  private livenessClaimPending(sessionUuid: string): boolean {
    if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
      return !this.livenessOwnershipClaimSent;
    }
    return this.otherHeldSessions.get(sessionUuid)?.claimSent === false;
  }

  private recordRecoveryAcknowledgement(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
  ): void {
    if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
      this.recordBoundSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership, () => true);
    } else if (this.otherHeldSessions.has(sessionUuid)) {
      this.recordHeldSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership);
    }
  }

  /** The daemon answered that a session it was heartbeated for no longer exists. */
  private dropGoneSession(sessionUuid: string): void {
    if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
      this.fenceBoundSessionUuid(sessionUuid, "session-not-found");
      return;
    }
    logger.warn(`[DaemonMcpProxy] Held session ${sessionUuid} is gone, no longer heartbeating it`);
    this.dropHeldSession(sessionUuid);
  }

  /**
   * Automatic recovery was exhausted: stop heartbeating the affected sessions, remember the
   * structured error for the next tool call that reaches each of them, and tell the harness now.
   */
  private deliverLivenessHandover(handover: LivenessHandover): void {
    logger.error(`[DaemonMcpProxy] ${handover.code}: ${livenessHandoverMessage(handover)}`);
    for (const { sessionUuid } of handover.sessions) {
      this.stallHandovers.set(sessionUuid, { handover, delivered: false });
    }
    for (const { sessionUuid } of handover.sessions) {
      if (sessionUuid === this.boundSessionUuid && !this.terminalBoundSession) {
        this.fenceBoundSessionUuid(sessionUuid, handover.code);
      } else {
        this.dropHeldSession(sessionUuid, true);
      }
    }
    if (handover.code === PROXY_STALLED_CODE) {
      // Recovery already received a definitive missing-session or superseded-owner answer.
      for (const { sessionUuid } of handover.sessions) {
        this.endLostSessionHandover(sessionUuid);
      }
    }
    for (const listener of this.livenessHandoverListeners) {
      try {
        listener(handover);
      } catch (error) {
        // Best-effort: a dead client transport must not stop the other listeners or the proxy.
        logger.warn(`[DaemonMcpProxy] liveness handover listener failed: ${error}`);
      }
    }
  }

  /**
   * A tool call names a session this proxy gave up on (#10053). The first one returns the
   * structured handover; naming it again attempts an observation-only claim with the same token.
   * Unreachable resumes retain the fence; a definitive loss queues one structured loss delivery.
   */
  private async reportStalledSessionNamedBy(args: Record<string, unknown>): Promise<void> {
    const sessionUuid = this.sessionUuidFromArgs(args);
    const record = sessionUuid ? this.stallHandovers.get(sessionUuid) : undefined;
    if (!sessionUuid || !record) {
      return;
    }
    if (!record.delivered) {
      record.delivered = true;
      throw new DaemonSessionStalledError(sessionUuid, record.handover);
    }
    try {
      await runWithoutDaemonLifecycle(() =>
        raceWithDeadline(
          async () => {
            await this.ensureConnected();
            await this.requireClient().callDaemonMethod(
              DAEMON_HEARTBEAT_METHOD,
              this.boundSessionHeartbeatParams(sessionUuid, true),
            );
          },
          {
            timer: this.timer,
            timeoutMs: this.heartbeatRequestTimeoutMs(),
            label: "Resume handed-over session",
          },
        ),
      );
    } catch (error) {
      if (this.isDefinitiveSessionLoss(error)) {
        this.endLostSessionHandover(sessionUuid);
        this.reportPendingSessionLoss(args);
        return;
      }
      logger.warn(
        "[DaemonMcpProxy] Handed-over session was not acknowledged; retaining lifecycle fence",
        error,
      );
      throw new DaemonSessionStalledError(sessionUuid, record.handover);
    }
    this.stallHandovers.delete(sessionUuid);
    if (this.terminalBoundSession?.sessionUuid === sessionUuid) {
      this.terminalBoundSession = undefined;
    }
  }

  private isDefinitiveSessionLoss(error: unknown): boolean {
    return (
      (error !== null &&
        typeof error === "object" &&
        "code" in error &&
        error.code === DAEMON_SESSION_NOT_FOUND_CODE) ||
      isLivenessOwnershipLostError(error) ||
      isLivenessOwnerConflictError(error)
    );
  }

  private endLostSessionHandover(sessionUuid: string): void {
    const record = this.stallHandovers.get(sessionUuid);
    if (!record) {
      return;
    }
    // A delivered proxy_stalled already reported this definitive loss. daemon_stalled did not.
    if (record.handover.code !== PROXY_STALLED_CODE || !record.delivered) {
      this.pendingSessionLosses.set(sessionUuid, {
        ...record.handover,
        code: PROXY_STALLED_CODE,
        sessions: record.handover.sessions.filter((session) => session.sessionUuid === sessionUuid),
        lastAcknowledgedHeartbeatAt:
          record.handover.sessions.find((session) => session.sessionUuid === sessionUuid)
            ?.lastAcknowledgedHeartbeatAt ?? record.handover.lastAcknowledgedHeartbeatAt,
        action: "reacquire_lost_sessions",
      });
    }
    this.forgetSessionLivenessState(sessionUuid);
    this.ownedDeviceSessions.delete(sessionUuid);
    this.claimableSessions.delete(sessionUuid);
    if (this.terminalBoundSession?.sessionUuid === sessionUuid) {
      this.terminalBoundSession.reason = "session-not-found";
    }
  }

  private reportToolSessionLoss(name: string, args: Record<string, unknown>): void {
    if (this.pendingSessionLosses.size === 0) {
      return;
    }
    const sessionless =
      isDeviceSessionAcquisitionTool(name) ||
      isDeviceInventoryTool(name) ||
      name === SET_TOOL_ENABLED_TOOL_NAME;
    const usesDeviceSelector =
      this.toolTargetsDevice(name) &&
      this.hasImplicitDeviceSelector(args, name === "setActiveDevice");
    this.reportPendingSessionLoss(
      args,
      !sessionless && !this.canUseSurvivingSession(args, usesDeviceSelector),
    );
  }

  private reportPendingSessionLoss(args: Record<string, unknown>, terminalRouted = true): void {
    const sessionUuid =
      this.sessionUuidFromArgs(args) ??
      (terminalRouted ? this.terminalBoundSession?.sessionUuid : undefined);
    const loss = sessionUuid ? this.pendingSessionLosses.get(sessionUuid) : undefined;
    if (sessionUuid && loss) {
      this.pendingSessionLosses.delete(sessionUuid);
      throw new DaemonSessionStalledError(sessionUuid, loss);
    }
  }

  /**
   * The daemon refused a tool call because the session is suspect: its owner can still restore it.
   * Returns the refusal when the call may be forwarded once more after that recovery.
   */
  private noteSuspectSessionResult(
    name: string,
    result: unknown,
    forwardedArgs: Record<string, unknown>,
    allowRetry: boolean,
  ): DeviceSessionSuspectRefusal | undefined {
    const sessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (!sessionUuid || !this.isHeldSession(sessionUuid) || !declaresDeviceSessionSuspect(result)) {
      return undefined;
    }
    logger.warn(`[DaemonMcpProxy] Session ${sessionUuid} is suspect; re-heartbeating it now`);
    this.livenessRecovery.begin(sessionUuid, DAEMON_STALLED_CODE);
    const refusal = readDeviceSessionSuspectRefusal(result);
    return allowRetry &&
      refusal &&
      isSuspectRefusalRetryable(name, sessionUuid, refusal) &&
      this.livenessRecovery.isRecovering(sessionUuid)
      ? refusal
      : undefined;
  }

  /** Stop heartbeating held sessions no tool call has named within the idle window (#10657). */
  private evictAbandonedHeldSessions(): void {
    const now = this.timer.now();
    for (const [sessionUuid, held] of [...this.otherHeldSessions]) {
      if (now - held.lastUsedAt >= DAEMON_BOUND_SESSION_REPLAY_TTL_MS) {
        logger.info(
          `[DaemonMcpProxy] Held session ${sessionUuid} was not used for ${DAEMON_BOUND_SESSION_REPLAY_TTL_MS}ms; no longer heartbeating it`,
        );
        this.dropHeldSession(sessionUuid);
      }
    }
  }

  private async heartbeatOtherHeldSessions(): Promise<void> {
    this.evictAbandonedHeldSessions();
    await Promise.all(
      [...this.otherHeldSessions.keys()].map((sessionUuid) =>
        this.heartbeatHeldSession(sessionUuid),
      ),
    );
  }

  /** Never rejects: a held session's failure is logged and must not stop its siblings. */
  private async heartbeatHeldSession(sessionUuid: string): Promise<void> {
    const held = this.otherHeldSessions.get(sessionUuid);
    if (!held || this.closing) {
      return;
    }
    const claimLivenessOwnership = !held.claimSent;
    try {
      await this.heartbeatWithStallDetection(sessionUuid, async (isCurrent) => {
        // Fencing the latest binding must not silence its siblings, hence
        // allowReleasedSession. Not-found is not proof of loss here, as on the
        // latest binding's tick: the release notification is authoritative.
        await runWithoutDaemonLifecycle(() =>
          this.withRecoverableReconnect(
            () => this.sendHeldSessionHeartbeat(sessionUuid, claimLivenessOwnership),
            sessionUuid,
            true,
            false,
          ),
        );
        if (isCurrent()) {
          this.recordHeldSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership);
        }
      });
    } catch (error) {
      this.handleHeldSessionHeartbeatError(sessionUuid, claimLivenessOwnership, error);
    }
  }

  /**
   * One held session's heartbeat. The daemon answering "session not found" is an answer about this
   * session alone: it is raised as {@link HeldSessionNotFoundError}, which the shared reconnect
   * machinery does not treat as a stale connection, so it never resets the one socket every other
   * session and tool call is using.
   */
  private async sendHeldSessionHeartbeat(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
  ): Promise<void> {
    try {
      await this.requireClient().callDaemonMethod(
        DAEMON_HEARTBEAT_METHOD,
        this.boundSessionHeartbeatParams(sessionUuid, claimLivenessOwnership),
      );
    } catch (error) {
      if (this.isDaemonSessionNotFoundError(error)) {
        throw new HeldSessionNotFoundError(sessionUuid);
      }
      throw error;
    }
  }

  /**
   * Run one session's periodic heartbeat. An ownership refusal, a lost session or any other answer
   * from the daemon is handled by the caller; the absence of an acknowledgement (the heartbeat
   * timed out or the daemon was unreachable) starts bounded recovery for that session (#10053)
   * instead of a time-threshold fence.
   */
  private async heartbeatWithStallDetection(
    sessionUuid: string,
    send: (isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> {
    if (this.livenessRecovery.isRecovering(sessionUuid)) {
      return;
    }
    let abandoned = false;
    try {
      await raceWithDeadline(() => send(() => !abandoned), {
        timer: this.timer,
        timeoutMs: this.heartbeatRequestTimeoutMs(),
        label: "Bound-session heartbeat",
        onTimeout: () => {
          abandoned = true;
        },
      });
    } catch (error) {
      abandoned = true;
      if (this.closing) {
        return;
      }
      if (error instanceof LifecycleConnectionInFlightError) {
        // The heartbeat was never sent: a tool call is establishing the shared connection. That
        // says nothing about the daemon, and the next tick retries on that connection (#10508).
        logger.debug(
          `[DaemonMcpProxy] Heartbeat for session ${sessionUuid} deferred: ${errorMessage(error)}`,
        );
        return;
      }
      if (!this.isMissingHeartbeatAcknowledgement(error)) {
        throw error;
      }
      logger.warn(
        `[DaemonMcpProxy] No heartbeat acknowledgement for session ${sessionUuid}: ${errorMessage(error)}; starting recovery`,
      );
      this.livenessRecovery.begin(sessionUuid, DAEMON_STALLED_CODE);
    }
  }

  /**
   * Whether a failed heartbeat means the daemon never answered, as opposed to answering with a
   * refusal (ownership, unknown session, fenced binding) that its own handler deals with.
   */
  private isMissingHeartbeatAcknowledgement(error: unknown): boolean {
    if (
      error instanceof DaemonBoundSessionExpiredError ||
      error instanceof HeldSessionNotFoundError ||
      this.isDaemonSessionNotFoundError(error)
    ) {
      return false;
    }
    if (isLivenessOwnerConflictError(error)) {
      return false;
    }
    return !isLivenessOwnershipLostError(error);
  }

  private recordHeldSessionHeartbeatSuccess(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
  ): void {
    const held = this.otherHeldSessions.get(sessionUuid);
    if (held && claimLivenessOwnership) {
      held.claimSent = true;
    }
    if (held) {
      held.conflictSince = undefined;
    }
    this.livenessAcks.set(sessionUuid, this.timer.now());
    this.livenessConflictLogged.delete(sessionUuid);
  }

  private handleHeldSessionHeartbeatError(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
    error: unknown,
  ): void {
    if (this.closing) {
      return;
    }
    if (isLivenessOwnershipLostError(error)) {
      // Same informational outcome as the latest binding: no fencing or re-claim.
      this.recordHeldSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership);
      return;
    }
    if (error instanceof HeldSessionNotFoundError) {
      // The daemon does not know this session. Drop it once; retrying every tick would only
      // keep asking, and resetting the socket to ask again would hurt its siblings.
      this.dropGoneSession(sessionUuid);
      return;
    }
    if (isLivenessOwnerConflictError(error)) {
      this.handleHeldSessionOwnerConflict(sessionUuid);
      return;
    }
    if (error instanceof DaemonBoundSessionExpiredError) {
      logger.warn(
        `[DaemonMcpProxy] Held session ${sessionUuid} is gone, no longer heartbeating: ${error.message}`,
        error,
      );
      this.dropHeldSession(sessionUuid);
      return;
    }
    logger.warn(
      `[DaemonMcpProxy] Heartbeat for held session ${sessionUuid} failed: ${errorMessage(error)}`,
      error,
    );
  }

  /**
   * The daemon refused this held session's claim because another token owns it
   * with a live lease (#10050). The claim stays unsent so each tick retries it,
   * which succeeds once that lease lapses. The other owner's session stays refused for
   * its lease plus the suspect grace window (#10051), so a refusal is only given up on
   * after {@link ownershipConflictLeashMs}: one that outlasts it means this proxy cannot
   * own the session, so it stops heartbeating that session alone; siblings are unaffected.
   */
  private handleHeldSessionOwnerConflict(sessionUuid: string): void {
    const held = this.otherHeldSessions.get(sessionUuid);
    if (!held) {
      return;
    }
    const now = this.timer.now();
    held.conflictSince ??= now;
    if (now - held.conflictSince >= this.ownershipConflictLeashMs) {
      logger.warn(
        `[DaemonMcpProxy] Held session ${sessionUuid} is owned by another live liveness owner; no longer heartbeating it`,
      );
      this.livenessConflictLogged.delete(sessionUuid);
      this.dropHeldSession(sessionUuid);
      return;
    }
    this.noteLivenessOwnerConflict(sessionUuid);
  }

  private noteLivenessOwnerConflict(sessionUuid: string): void {
    if (this.livenessConflictLogged.has(sessionUuid)) {
      return;
    }
    this.livenessConflictLogged.add(sessionUuid);
    logger.warn(
      `[DaemonMcpProxy] Session ${sessionUuid} is owned by another live liveness owner; retrying the claim until its lease expires`,
    );
  }

  /**
   * Forget what the proxy tracks per session for liveness once it stops heartbeating it. A
   * session handed over for a stall stays resumable by UUID, so its device and the pending
   * handover are kept for the harness's next call.
   */
  private forgetSessionLivenessState(sessionUuid: string, keepHandover = false): void {
    this.livenessAcks.delete(sessionUuid);
    this.livenessConflictLogged.delete(sessionUuid);
    if (!keepHandover) {
      this.sessionDeviceIds.delete(sessionUuid);
      this.stallHandovers.delete(sessionUuid);
    }
  }

  /** Stop heartbeating a held session; idle the keeper once nothing remains to heartbeat. */
  private dropHeldSession(sessionUuid: string, keepHandover = false): void {
    if (!this.otherHeldSessions.delete(sessionUuid)) {
      return;
    }
    this.forgetSessionLivenessState(sessionUuid, keepHandover);
    if (this.otherHeldSessions.size === 0 && !this.latestBindingClaimable()) {
      void this.stopBoundSessionHeartbeat();
    }
  }

  /** The latest binding moves on: its session stays held and keeps its claim state. */
  private holdPreviousBinding(nextSessionUuid: string): void {
    const previous = this.boundSessionUuid;
    this.otherHeldSessions.delete(nextSessionUuid);
    this.latestBindingConflict = undefined;
    // Only a session this proxy claims stays held: an args-named one was never heartbeated (#10664).
    if (previous && previous !== nextSessionUuid && this.claimableSessions.has(previous)) {
      this.otherHeldSessions.set(previous, {
        claimSent: this.livenessOwnershipClaimSent,
        lastUsedAt: this.boundSessionUuidAt ?? this.timer.now(),
      });
    }
  }

  private async runLatestBindingHeartbeatTick(): Promise<void> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || !this.latestBindingClaimable() || this.closing) {
      return;
    }
    // A caller that explicitly schedules heartbeats beyond the lease cannot
    // maintain daemon ownership by cadence. Preserve that opt-out's prior
    // single-flight behavior (used by replay-lease tests).
    if (this.heartbeatIntervalMs >= this.heartbeatLeashMs) {
      await this.sendBoundSessionHeartbeat();
      return;
    }
    await this.heartbeatWithStallDetection(sessionUuid, (isCurrent) =>
      this.sendBoundSessionHeartbeat(isCurrent),
    );
  }

  private async sendBoundSessionHeartbeat(isCurrent: () => boolean = () => true): Promise<void> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || !this.latestBindingClaimable() || this.closing) {
      return;
    }
    try {
      const claimLivenessOwnership = !this.livenessOwnershipClaimSent;
      await runWithoutDaemonLifecycle(() =>
        this.withRecoverableReconnect(
          () =>
            this.requireClient().callDaemonMethod(
              DAEMON_HEARTBEAT_METHOD,
              this.boundSessionHeartbeatParams(sessionUuid, claimLivenessOwnership),
            ),
          sessionUuid,
          undefined,
          // A replacement daemon has not materialized a persisted session until a
          // device operation reaches recovery. Heartbeat misses before that point
          // are not proof that the UUID is terminal; the first tool call remains
          // responsible for either restoring it or applying the existing fence.
          false,
        ),
      );
      this.recordBoundSessionHeartbeatSuccess(sessionUuid, claimLivenessOwnership, isCurrent);
    } catch (error) {
      if (this.absorbOwnershipRefusal(error, sessionUuid, isCurrent)) {
        return;
      }
      if (error instanceof DaemonBoundSessionExpiredError) {
        // Terminal fencing already stopped the keeper; this tick has no further work.
        logger.debug(`[DaemonMcpProxy] Bound-session heartbeat stopped: ${error.message}`);
        return;
      }
      throw error;
    }
  }

  /**
   * Handle the daemon refusing the latest binding's heartbeat on ownership grounds.
   * Returns true when the refusal was absorbed (no fencing, reconnecting or failing
   * the keeper).
   */
  private absorbOwnershipRefusal(
    error: unknown,
    sessionUuid: string,
    isCurrent: () => boolean,
  ): boolean {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE ||
        error.code === DAEMON_LIVENESS_OWNER_UNOWNED_CODE)
    ) {
      // #10115: a refusal proves transport reachability, not ownership. Do not
      // fence or re-claim: that would undo a deliberate handoff. Report the loss
      // visibly once; the local acknowledgement only prevents transport recovery.
      if (!this.livenessSupersessionLogged) {
        this.livenessSupersessionLogged = true;
        logger.warn(
          `[DaemonMcpProxy] Session ${sessionUuid} liveness ownership lost; this proxy no longer protects its deadline. Stop its keeper or explicitly claim with a fresh token.`,
        );
      }
      this.recordBoundSessionHeartbeatSuccess(sessionUuid, false, isCurrent);
      return true;
    }
    if (isLivenessOwnerConflictError(error)) {
      // Another token owns this session with a live lease. Nothing was recorded
      // (no local acknowledgement either), the claim stays unsent so the next
      // tick retries it, and the keeper is not failed by the refusal.
      this.noteLivenessOwnerConflict(sessionUuid);
      this.leashLatestBindingConflict(sessionUuid, isCurrent);
      return true;
    }
    return false;
  }

  /**
   * Give the latest binding the same leash held sessions have (#10664): a refusal that outlasts
   * the other owner's lease plus grace means this proxy cannot own the session, so it stops
   * claiming and fences the binding instead of inheriting another proxy's session.
   */
  private leashLatestBindingConflict(sessionUuid: string, isCurrent: () => boolean): void {
    if (!isCurrent() || this.boundSessionUuid !== sessionUuid || this.terminalBoundSession) {
      return;
    }
    const now = this.timer.now();
    if (this.latestBindingConflict?.sessionUuid !== sessionUuid) {
      this.latestBindingConflict = { sessionUuid, since: now };
    }
    if (now - this.latestBindingConflict.since < this.ownershipConflictLeashMs) {
      return;
    }
    logger.warn(
      `[DaemonMcpProxy] Session ${sessionUuid} is owned by another live liveness owner; no longer claiming it`,
    );
    this.fenceBoundSessionUuid(sessionUuid, "liveness-owner-conflict");
  }

  private recordBoundSessionHeartbeatSuccess(
    sessionUuid: string,
    claimLivenessOwnership: boolean,
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent() || this.boundSessionUuid !== sessionUuid || this.terminalBoundSession) {
      return;
    }
    if (claimLivenessOwnership) {
      this.livenessOwnershipClaimSent = true;
    }
    this.livenessConflictLogged.delete(sessionUuid);
    this.latestBindingConflict = undefined;
    this.boundSessionUuidAt = this.timer.now();
    this.livenessAcks.set(sessionUuid, this.timer.now());
  }

  // Record that the daemon released a specific session UUID, advancing the global
  // release epoch. An in-flight call that forwarded this exact UUID compares its
  // captured epoch against this entry and declines to resurrect the released
  // session on completion (issue #4655). Scoping the record to the UUID — not a
  // global counter — is what lets an unrelated session's release NOT block
  // remembering the session another in-flight call forwarded.
  private recordSessionReleased(sessionUuid: string, reason?: string): void {
    const normalizedSessionUuid = sessionUuid.trim();
    if (normalizedSessionUuid.length === 0) {
      return;
    }
    this.releaseEpoch += 1;
    if (
      !this.activeReleaseEpochReferences.has(normalizedSessionUuid) &&
      this.activeAcquisitionReleaseEpochs.size === 0
    ) {
      return;
    }
    this.releasedSessionEpochs.set(normalizedSessionUuid, this.releaseEpoch);
    this.releasedSessionReasons.set(normalizedSessionUuid, reason ?? "released");
  }

  private retainReleaseEpochReference(sessionUuid: string | undefined): void {
    if (!sessionUuid) {
      return;
    }
    this.activeReleaseEpochReferences.set(
      sessionUuid,
      (this.activeReleaseEpochReferences.get(sessionUuid) ?? 0) + 1,
    );
  }

  private releaseReleaseEpochReference(sessionUuid: string | undefined): void {
    if (!sessionUuid) {
      return;
    }
    const references = (this.activeReleaseEpochReferences.get(sessionUuid) ?? 0) - 1;
    if (references > 0) {
      this.activeReleaseEpochReferences.set(sessionUuid, references);
      return;
    }
    this.activeReleaseEpochReferences.delete(sessionUuid);
    const releasedAtEpoch = this.releasedSessionEpochs.get(sessionUuid);
    if (
      releasedAtEpoch === undefined ||
      !this.isReleaseNeededByActiveAcquisition(releasedAtEpoch)
    ) {
      this.releasedSessionEpochs.delete(sessionUuid);
      this.releasedSessionReasons.delete(sessionUuid);
    }
  }

  private retainAcquisitionReleaseEpoch(isSessionAcquisition: boolean, epoch: number): void {
    if (!isSessionAcquisition) {
      return;
    }
    this.activeAcquisitionReleaseEpochs.set(
      epoch,
      (this.activeAcquisitionReleaseEpochs.get(epoch) ?? 0) + 1,
    );
  }

  private releaseAcquisitionReleaseEpoch(isSessionAcquisition: boolean, epoch: number): void {
    if (!isSessionAcquisition) {
      return;
    }
    const references = (this.activeAcquisitionReleaseEpochs.get(epoch) ?? 0) - 1;
    if (references > 0) {
      this.activeAcquisitionReleaseEpochs.set(epoch, references);
    } else {
      this.activeAcquisitionReleaseEpochs.delete(epoch);
    }
    for (const [sessionUuid, releasedAtEpoch] of this.releasedSessionEpochs) {
      if (
        !this.activeReleaseEpochReferences.has(sessionUuid) &&
        !this.isReleaseNeededByActiveAcquisition(releasedAtEpoch)
      ) {
        this.releasedSessionEpochs.delete(sessionUuid);
        this.releasedSessionReasons.delete(sessionUuid);
      }
    }
  }

  private isReleaseNeededByActiveAcquisition(releasedAtEpoch: number): boolean {
    for (const acquisitionEpoch of this.activeAcquisitionReleaseEpochs.keys()) {
      if (releasedAtEpoch > acquisitionEpoch) {
        return true;
      }
    }
    return false;
  }

  private forwardedSessionReleaseReasonSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): string | undefined {
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (!forwardedUuid) {
      return undefined;
    }
    return this.sessionReleaseReasonSince(forwardedUuid, forwardEpoch);
  }

  private sessionReleaseReasonSince(sessionUuid: string, forwardEpoch: number): string | undefined {
    if ((this.releasedSessionEpochs.get(sessionUuid) ?? 0) <= forwardEpoch) {
      return undefined;
    }
    return this.releasedSessionReasons.get(sessionUuid) ?? "released";
  }

  private throwIfSessionReleasedSince(sessionUuid: string, forwardEpoch: number): void {
    const releaseReason = this.sessionReleaseReasonSince(sessionUuid, forwardEpoch);
    if (releaseReason) {
      throw new DaemonBoundSessionExpiredError(sessionUuid, releaseReason);
    }
  }

  private fenceReleasedForwardedSession(
    forwardedArgs: Record<string, unknown>,
    reason: string,
  ): void {
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs) ?? "";
    if (
      forwardedUuid.length > 0 &&
      (!this.boundSessionUuid || this.boundSessionUuid === forwardedUuid)
    ) {
      this.fenceBoundSessionUuid(forwardedUuid, reason);
    }
  }

  private throwIfForwardedSessionReleasedSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): void {
    const reason = this.forwardedSessionReleaseReasonSince(forwardedArgs, forwardEpoch);
    if (!reason) {
      return;
    }
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs)!;
    this.fenceReleasedForwardedSession(forwardedArgs, reason);
    if (this.terminalBoundSession?.sessionUuid === forwardedUuid) {
      throw this.boundSessionExpiredError();
    }
    throw new DaemonBoundSessionExpiredError(forwardedUuid, reason);
  }

  // Bind and heartbeat the device session an acquisition call
  // minted in its RESULT — the proxy equivalent of the direct-path bind in
  // src/server/index.ts. Without this the daemon never sees an ownership heartbeat
  // for a result-minted session and reaps it under the pre-first-heartbeat grace
  // (issue #5689). Acquisition also clears any terminal fence: the connection is
  // usable again once a fresh session is established (AC2).
  private async bindResultMintedDeviceSession(
    name: string,
    result: unknown,
    acquisitionReleaseEpoch: number,
  ): Promise<void> {
    if (!isDeviceSessionAcquisitionTool(name)) {
      return;
    }
    const mintedSessionUuid = getDeviceSessionIdFromResult(result);
    if (!mintedSessionUuid || mintedSessionUuid === this.boundSessionUuid) {
      return;
    }
    this.throwIfSessionReleasedSince(mintedSessionUuid, acquisitionReleaseEpoch);
    this.rememberSessionDevice(mintedSessionUuid, getDeviceIdFromResult(result));
    // A prior binding's keeper must not outlive the rebind to a fresh session.
    // (A terminal fence already stopped it; this covers re-acquiring over a live
    // binding.)
    if (this.heartbeatKeeperStarted) {
      await this.stopBoundSessionHeartbeat();
    }
    // Stopping the previous binding's keeper may yield. Recheck before publishing
    // the new binding so a release delivered during that await cannot be missed.
    this.throwIfSessionReleasedSince(mintedSessionUuid, acquisitionReleaseEpoch);
    this.terminalBoundSession = undefined;
    this.holdPreviousBinding(mintedSessionUuid);
    this.boundSessionUuid = mintedSessionUuid;
    this.boundSessionUuidAt = this.timer.now();
    this.ownedDeviceSessions.add(mintedSessionUuid);
    this.claimableSessions.add(mintedSessionUuid);
    this.boundSessionFromResultMint = true;
    this.initialSessionBindingConfigured = false;
    this.livenessOwnershipClaimSent = false;
    // `tools/list` is forwarded under the bound session, so the binding just
    // published invalidates every cached definition fetched under the previous
    // scope. Drop it BEFORE the awaited heartbeat: the daemon's own
    // `tools/list_changed` for an `enableTools` grant is relayed while this
    // acquisition is still in flight, so a client that re-listed on it cached a
    // list scoped to the OLD binding and nothing else would clear it
    // (#6886 review).
    this.invalidateListCache("tools");
    // `resources/list` and `resources/templates/list` are forwarded under the
    // bound session too, so a list cached under the previous scope (an unbound
    // list, or the prior binding's) must not be served for the new session.
    this.invalidateListCache("resources");
    // Deliver the first ownership heartbeat as part of the acquisition so the
    // daemon records ownership before the pre-first-heartbeat grace fires
    // (mirrors the establishment guarantee in issue #5637).
    await this.establishBoundSessionHeartbeat();
    // Prompt the client to re-fetch only once the daemon has recorded ownership
    // of the new session, so the re-list it triggers is already routable.
    this.notifyListChanged("tools");
    // The first heartbeat is an awaited daemon round-trip. A shutdown release
    // can arrive while it is in flight, fence and clear the binding, and make
    // this acquisition result stale before it reaches the caller.
    this.throwIfSessionReleasedSince(mintedSessionUuid, acquisitionReleaseEpoch);
  }

  /** Learn which device a session runs on so a liveness handover can name it (#10053). */
  private rememberSessionDevice(sessionUuid: string, deviceId: unknown): void {
    if (typeof deviceId === "string" && deviceId.trim().length > 0) {
      this.sessionDeviceIds.set(sessionUuid, deviceId);
    }
  }

  // Called with the FORWARDED args (post-withBoundSessionUuid), so an implicit
  // sessionless call that had the bound UUID injected refreshes the replay lease
  // just like an explicit-sessionUuid call, matching the daemon session it just
  // extended (issue #4610).
  private rememberSessionUuid(
    name: string,
    forwardedArgs: Record<string, unknown>,
    callReleaseEpoch: number,
  ): void {
    if (name === "executePlan") {
      // The daemon owns plan-session release. Preserve the binding until its
      // release notification (or heartbeat not-found fallback) terminally fences
      // this transport.
      return;
    }
    if (name === SET_TOOL_ENABLED_TOOL_NAME) {
      return;
    }
    if (isDeviceInventoryTool(name)) {
      // Inventory observation must not bind or heartbeat a session it does not own.
      return;
    }
    // A release for the FORWARDED UUID observed WHILE this call was in flight
    // already recorded that UUID's release (handleDaemonNotification).
    // Re-remembering it now would resurrect the freed session and let the next
    // sessionless call recreate it (issue #4611). Scoped to the forwarded UUID so
    // an unrelated session's mid-call release does NOT block this remember (issue
    // #4655); a later explicit call re-binds normally.
    const releaseReason = this.forwardedSessionReleaseReasonSince(forwardedArgs, callReleaseEpoch);
    if (releaseReason) {
      this.fenceReleasedForwardedSession(forwardedArgs, releaseReason);
      return;
    }
    const rememberedSessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (
      rememberedSessionUuid &&
      (rememberedSessionUuid === this.boundSessionUuid || this.toolAcceptsSessionUuid(name))
    ) {
      if (
        this.terminalBoundSession &&
        rememberedSessionUuid !== this.terminalBoundSession.sessionUuid &&
        this.ownedDeviceSessions.has(rememberedSessionUuid)
      ) {
        this.terminalBoundSession = undefined;
      }
      this.rememberSessionDevice(rememberedSessionUuid, forwardedArgs.deviceId);
      this.updateBoundSessionUuid(rememberedSessionUuid);
      this.startBoundSessionHeartbeat();
    }
  }

  private toolAcceptsSessionUuid(name: string): boolean {
    const tool =
      this.cachedTools?.find((definition) => definition.name === name) ??
      this.staticToolDefinitionsProvider().find((definition) => definition.name === name);
    const properties = tool?.inputSchema.properties;
    return typeof properties === "object" && properties !== null && "sessionUuid" in properties;
  }

  // Bind `sessionUuid`, refreshing the replay lease. A change to a different UUID
  // marks the binding client-declared: the new UUID came from a call's args, not
  // a device-acquisition result. A sessionless refresh re-binds the same
  // result-minted UUID and preserves its provenance (issue #5689).
  private updateBoundSessionUuid(sessionUuid: string): void {
    if (sessionUuid !== this.boundSessionUuid) {
      this.holdPreviousBinding(sessionUuid);
      this.boundSessionFromResultMint = false;
      this.livenessOwnershipClaimSent = false;
    }
    this.boundSessionUuid = sessionUuid;
    this.boundSessionUuidAt = this.timer.now();
    this.ownedDeviceSessions.add(sessionUuid);
  }

  // Refresh the replay lease for a call that was ADMITTED and forwarded to the
  // daemon handler but then REJECTED. getOrCreateSession() already refreshed the
  // live daemon session before the handler ran, so the proxy lease must track
  // that liveness even on failure — otherwise repeated admitted-but-failed calls
  // retire a still-live session and a reconnect seeds an unbound transport
  // (issue #4610). Excluded, because none of them refreshed a live session:
  //   - executePlan owns its own binding lifecycle via the release signal; leave
  //     it untouched so a pre-handler plan rejection does not strand the binding.
  //   - inventory tools are observation-only and their read-only admission did not
  //     acquire or refresh the forwarded session.
  //   - a recoverable error (DaemonUnavailableError transport/connect failure,
  //     "Session not found", or an unknown-tool build-skew), or a device-control
  //     connect-phase failure never reached the handler with a live session; a
  //     response failure with sessionValid=false confirms the session is stale.
  //     Neither may refresh or establish the replay lease.
  private refreshReplayLeaseAfterAdmittedFailure(
    name: string,
    forwardedArgs: Record<string, unknown>,
    error: unknown,
    callReleaseEpoch: number,
  ): void {
    if (
      name === "executePlan" ||
      name === "setActiveDevice" ||
      name === SET_TOOL_ENABLED_TOOL_NAME ||
      isDeviceInventoryTool(name) ||
      isUnprovenSessionAdmissionError(error) ||
      this.isRecoverableDaemonSessionError(error) ||
      this.isPreDispatchDaemonSessionError(error) ||
      this.shouldSkipLeaseRefreshForDeviceControlTransportError(error)
    ) {
      return;
    }
    // As in rememberSessionUuid: a release of the forwarded UUID observed
    // mid-flight already recorded it, so an admitted-then-rejected call must not
    // re-refresh the released UUID's lease (issue #4611/#4655). The session is
    // gone; resurrecting the lease would replay it on the next sessionless call.
    const releaseReason = this.forwardedSessionReleaseReasonSince(forwardedArgs, callReleaseEpoch);
    if (releaseReason) {
      this.fenceReleasedForwardedSession(forwardedArgs, releaseReason);
      return;
    }
    const admittedSessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (admittedSessionUuid) {
      this.updateBoundSessionUuid(admittedSessionUuid);
      this.startBoundSessionHeartbeat();
    }
  }

  /**
   * Own the forwarded device session behind an `isError: true` RESULT.
   *
   * A failed interaction tool answers with an ordinary MCP error envelope rather
   * than a rejection, so the handler DID run against the forwarded session and
   * that session is still live — exactly what
   * {@link refreshReplayLeaseAfterAdmittedFailure} assumes on the throwing path.
   * Binding it here too is what lets a `--cli --session-uuid` invocation whose
   * very first call fails still declare the session CLI-owned before exiting;
   * without it the session stayed on the 10 s heartbeat policy and the retry
   * after ordinary think-time got `session_ownership_lost` (issue #6870).
   *
   * An error result may only ESTABLISH a first binding, never SWITCH one: a call
   * that names some OTHER session and fails leaves the connection on the session
   * it already had, so an unissued UUID cannot steal the binding (issue #2737).
   * executePlan is excluded before checking for a released forwarded session:
   * the daemon owns plan-session release, and its notification fences only an
   * already-bound connection. A failed plan on an unbound connection must leave
   * it unbound, matching rememberSessionUuid on successful results.
   * Three further answers establish nothing:
   *   - a connection already fenced terminally — its session is gone;
   *   - a tool that does not route by device session (`setToolEnabled`,
   *     `setActiveDevice`), only observes inventory, or mints its session in the RESULT
   *     (the acquisition tools, handled above);
   *   - an envelope that declares the named session gone
   *     ({@link declaresDeviceSessionInvalid}) — resurrecting it would heartbeat
   *     a dead session instead of leaving the connection unbound.
   * Refreshing the lease of the ALREADY-bound session keeps its prior behaviour,
   * minus the session-invalid case, which was never a live session to refresh.
   */
  private bindForwardedSessionOnErrorResult(
    name: string,
    forwardedArgs: Record<string, unknown>,
    result: unknown,
    callReleaseEpoch: number,
  ): void {
    if (name === "executePlan") {
      return;
    }
    const releaseReason = this.forwardedSessionReleaseReasonSince(forwardedArgs, callReleaseEpoch);
    if (releaseReason) {
      this.fenceReleasedForwardedSession(forwardedArgs, releaseReason);
      return;
    }
    const forwardedSessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (!forwardedSessionUuid || declaresDeviceSessionInvalid(result)) {
      return;
    }
    const alreadyBound = forwardedSessionUuid === this.boundSessionUuid;
    if (
      !alreadyBound &&
      (this.boundSessionUuid !== undefined ||
        this.terminalBoundSession !== undefined ||
        !this.mayBindSessionFromErrorResult(name))
    ) {
      return;
    }
    this.updateBoundSessionUuid(forwardedSessionUuid);
    this.startBoundSessionHeartbeat();
  }

  private mayBindSessionFromErrorResult(name: string): boolean {
    if (
      name === "executePlan" ||
      name === "setActiveDevice" ||
      name === SET_TOOL_ENABLED_TOOL_NAME ||
      isDeviceInventoryTool(name) ||
      isDeviceSessionAcquisitionTool(name)
    ) {
      return false;
    }
    return this.toolAcceptsSessionUuid(name);
  }

  private async toolUnavailableError(
    name: string,
    daemonRejection?: string,
    daemonGated = false,
  ): Promise<Error> {
    let daemonIdentity: BuildIdentity = { entryScript: "", buildId: "unknown" };
    try {
      const status = await this.daemonManager.status();
      daemonIdentity = buildIdentityFromStatus(status);
    } catch (error) {
      logger.warn(
        `[DaemonMcpProxy] Failed to read daemon status for tool-unavailable error: ${error}`,
      );
    }
    if (!this.frontendRegistersTool(name)) {
      if (daemonGated && daemonRejection !== undefined) {
        // The daemon registers a tool this frontend has never heard of (a newer
        // daemon); its rejection already carries the gate reason.
        return Object.assign(new Error(daemonRejection), { code: DAEMON_TOOL_UNAVAILABLE_CODE });
      }
      const hint = getRemovedToolHint(name);
      return new Error(`Unknown tool "${name}".${hint ? ` ${hint}` : ""}`);
    }
    return new DaemonToolUnavailableError({
      toolName: name,
      client: this.buildIdentity,
      daemon: daemonIdentity,
      // A gate is daemon configuration, not skew: whatever the build identities say,
      // never tell the caller to restart the daemon for it.
      buildMismatch: daemonGated
        ? false
        : !buildIdentitiesMatch(this.buildIdentity, daemonIdentity),
      daemonRejection,
      gated: daemonGated,
    });
  }

  private frontendRegistersTool(name: string): boolean {
    const found =
      this.cachedTools?.find((definition) => definition.name === name) ??
      this.staticToolDefinitionsProvider().find((definition) => definition.name === name);
    return !!found;
  }

  /**
   * Get list of available resources from daemon
   */
  async listResources(): Promise<ProxiedResourceDefinition[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.listDuringLivenessFence(
        () => this.fetchResources(true),
        () => this.cachedResources ?? [],
      );
    }
    return this.fetchResources(this.discoveryAfterResultMintRelease());
  }

  private async fetchResources(releasedResultMint: boolean): Promise<ProxiedResourceDefinition[]> {
    // Return cached resources if available
    if (this.cachedResources) {
      return this.cachedResources;
    }

    try {
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = releasedResultMint ? {} : this.withBoundSessionUuid({});
      const result = await this.withRecoverableReconnect(
        () => this.requireClient().callDaemonMethod("resources/list", forwardedParams),
        this.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const resources = result?.resources ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResources() refetches. An unbound list
      // after a result-minted release is never cached: re-acquiring a session
      // does not invalidate the resource cache, so it would outlive the rebind.
      if (this.discoveryEpoch === discoveryEpoch && !releasedResultMint) {
        this.cachedResources = resources;
      }
      return resources;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resources: ${error}`);
      throw error;
    }
  }

  /**
   * Get list of resource templates from daemon
   */
  async listResourceTemplates(): Promise<ProxiedResourceTemplate[]> {
    if (this.hasLivenessLifecycleFence()) {
      return this.listDuringLivenessFence(
        () => this.fetchResourceTemplates(true),
        () => this.cachedResourceTemplates ?? [],
      );
    }
    return this.fetchResourceTemplates(this.discoveryAfterResultMintRelease());
  }

  private async fetchResourceTemplates(
    releasedResultMint: boolean,
  ): Promise<ProxiedResourceTemplate[]> {
    // Return cached templates if available
    if (this.cachedResourceTemplates) {
      return this.cachedResourceTemplates;
    }

    try {
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = releasedResultMint ? {} : this.withBoundSessionUuid({});
      const result = await this.withRecoverableReconnect(
        () => this.requireClient().callDaemonMethod("resources/list-templates", forwardedParams),
        this.sessionUuidFromArgs(forwardedParams),
        releasedResultMint,
      );
      const templates = result?.resourceTemplates ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResourceTemplates() refetches. Not
      // cached while unbound after a result-minted release (see listResources).
      if (this.discoveryEpoch === discoveryEpoch && !releasedResultMint) {
        this.cachedResourceTemplates = templates;
      }
      return templates;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resource templates: ${error}`);
      throw error;
    }
  }

  // Route a session-scoped observation read to the session named in its URI when
  // this connection owns that session but has since bound a newer one (e.g.
  // getApple after getAndroid). Forwarding the URI's session — not the latest
  // binding — makes the daemon seed the loopback SessionToolBinding with the
  // owning session, so the just-established owner is authorized instead of denied
  // with SCREENSHOT_ACCESS_DENIED (issue #5663). Returns undefined for any other
  // URI, a foreign/unowned session (which must keep forwarding this connection's
  // own binding and stay denied), or the current binding (already handled by
  // withBoundSessionUuid). A terminally fenced connection can still forward to a
  // different live owned session through canUseSurvivingSession, including its
  // still-owned configured initial session after a later binding is released.
  private freshScreenshotOwnerForwardParams(uri: string): Record<string, unknown> | undefined {
    const uriSessionUuid = sessionScopedObservationUriSessionUuid(uri);
    if (
      !uriSessionUuid ||
      uriSessionUuid === this.boundSessionUuid ||
      !this.ownedDeviceSessions.has(uriSessionUuid)
    ) {
      return undefined;
    }
    const configuredInitialSessionUuid = this.config.initialSessionUuid?.trim();
    const isLiveConfiguredInitialSession =
      uriSessionUuid === configuredInitialSessionUuid &&
      uriSessionUuid !== this.terminalBoundSession?.sessionUuid;
    if (
      this.terminalBoundSession &&
      !this.canUseSurvivingSession({ sessionUuid: uriSessionUuid }, false) &&
      !isLiveConfiguredInitialSession
    ) {
      return undefined;
    }
    return {
      sessionUuid: uriSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: uriSessionUuid,
    };
  }

  private throwIfResourceSessionHandedOver(uri: string): void {
    if (!this.connected || !this.client) {
      this.throwIfLivenessHandedOver();
    }
    if (isToolOutputResourceUri(uri)) {
      return;
    }
    const sessionUuid =
      sessionScopedObservationUriSessionUuid(uri) ??
      this.boundSessionUuid ??
      this.terminalBoundSession?.sessionUuid;
    const record = sessionUuid ? this.stallHandovers.get(sessionUuid) : undefined;
    if (sessionUuid && record) {
      throw new DaemonSessionStalledError(sessionUuid, record.handover);
    }
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(uri: string, { signal }: { signal?: AbortSignal } = {}): Promise<any> {
    signal?.throwIfAborted();
    await this.waitForLivenessRecovery(signal);
    this.throwIfResourceSessionHandedOver(uri);
    signal?.throwIfAborted();
    const terminalSessionUuid = this.terminalBoundSession?.sessionUuid;
    // A tool-output artifact read is session-independent, so it survives a
    // terminal release without any session params at all (issue #5917). The
    // fresh-screenshot exemption, by contrast, must still target the released
    // session it belongs to.
    const isToolOutput = isToolOutputResourceUri(uri);
    const isReleasedSessionScreenshot =
      terminalSessionUuid !== undefined && isFreshSessionScreenshotUri(uri, terminalSessionUuid);
    const ownerForwardedParams = isToolOutput
      ? undefined
      : this.freshScreenshotOwnerForwardParams(uri);
    const allowReleasedSession =
      isToolOutput || isReleasedSessionScreenshot || ownerForwardedParams !== undefined;
    const forwardedParams = isToolOutput
      ? {}
      : isReleasedSessionScreenshot
        ? {
            sessionUuid: terminalSessionUuid,
            [DAEMON_BOUND_SESSION_PARAM]: terminalSessionUuid,
            [DAEMON_RELEASED_SESSION_PARAM]: terminalSessionUuid,
          }
        : (ownerForwardedParams ?? this.withBoundSessionUuid({}));
    const forwarding = this.withRecoverableReconnect(
      () => this.requireClient().readResource(uri, forwardedParams, { signal }),
      this.sessionUuidFromArgs(forwardedParams),
      allowReleasedSession,
      true,
      undefined,
      signal,
    );
    // Recovery is shared with siblings; abandon this wait without cancelling it.
    return await raceWithDeadline(forwarding, {
      timer: this.timer,
      signal,
      label: `Daemon resource ${uri}`,
    });
  }

  /**
   * Invalidate cached definitions (call when daemon restarts)
   */
  invalidateCache(): void {
    this.cachedTools = null;
    this.cachedResources = null;
    this.cachedResourceTemplates = null;
  }

  /**
   * Check if connected to daemon
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Close the connection to daemon
   */
  async close(): Promise<void> {
    this.closing = true;
    this.connected = false;
    this.livenessRecovery.stop();
    this.resourceSubscriptions.clear();
    this.resourceUpdatedListeners.clear();
    this.structuredSessionNotFound = false;
    this.completeDaemonShutdownDisconnect();
    this.cancelBackgroundConnectRetry();
    this.cancelConnectedFallbackReconcile();
    this.connectionCloseReject?.(new DaemonUnavailableError("MCP proxy is closing"));
    await this.stopBoundSessionHeartbeat();
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = null;
    this.connected = false;
    this.clearBoundSessionUuid();
    this.otherHeldSessions.clear();
    this.livenessAcks.clear();
    this.sessionDeviceIds.clear();
    this.stallHandovers.clear();
    this.pendingSessionLosses.clear();
    this.livenessHandoverListeners.clear();
    this.ownedDeviceSessions.clear();
    this.terminalBoundSession = undefined;
    // Drain the per-UUID release-tracking maps at the close/reconnect boundary.
    // Ordinary completion already evicts each entry when its last in-flight
    // reference drops (issue #4655 / #5412), so these maps are bounded by the
    // count of concurrently in-flight calls. Clearing them on close is the
    // backstop the reference counter does not cover — a proxy closed with calls
    // still in flight, or reused across a reconnect, cannot retain release
    // records across its lifetime (issue #4689).
    this.releasedSessionEpochs.clear();
    this.releasedSessionReasons.clear();
    this.activeReleaseEpochReferences.clear();
    this.invalidateCache();
    logger.debug("[DaemonMcpProxy] Disconnected from daemon");
  }
}
