import { errorMessage } from "../utils/describeUnknownError";
import { shellQuote } from "../utils/shellQuote";
import {
  DaemonClient,
  DaemonUnavailableError,
  type DaemonClientLike,
  type DaemonClientFactory,
} from "./client";
import { DaemonManager, type DaemonManagerLike } from "./manager";
import { logger } from "../utils/logger";
import {
  SOCKET_PATH,
  DAEMON_STARTUP_TIMEOUT_MS,
  CONNECTION_TIMEOUT_MS,
  DAEMON_VERSION,
  DAEMON_VERSION_RESTART_COOLDOWN_MS,
  DAEMON_BOUND_SESSION_REPLAY_TTL_MS,
  DAEMON_TOOL_SELECTION_PROFILE_PARAM,
  DAEMON_BOUND_SESSION_PARAM,
  DAEMON_RELEASED_SESSION_PARAM,
} from "./constants";
import type { DaemonNotification, DaemonOptions } from "./types";
import { listChangedKindForMethod, type ListChangedKind } from "../server/listChangedBroadcast";
import { SESSION_RELEASED_NOTIFICATION_METHOD } from "../server/sessionReleaseBroadcast";
import {
  getDeviceSessionIdFromResult,
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
import { isExplicitPin, resolveAssetVersion, resolvePinnedVersion } from "../constants/release";
import { SingleFlightInterval } from "./SingleFlightInterval";
import type { SessionReleaseSnapshot } from "./sessionManager";
import {
  type BuildIdentity,
  buildIdentitiesMatch,
  buildIdentityFromStatus,
  describeBuildIdentity,
  getCurrentBuildIdentity,
} from "./buildIdentity";
import { DeviceControlTransportError } from "./deviceControlTransportFailure";
import { getStaticToolDefinitions } from "./staticToolDefinitions";

export type VersionMismatchReason =
  | "autoStartDisabled"
  | "cooldown"
  | "daemonNewer"
  | "nonNumeric"
  | "restartMismatch";

export type BuildMismatchReason = "autoStartDisabled" | "cooldown" | "restartMismatch";

const DAEMON_MCP_HEARTBEAT_INTERVAL_MS = 2_000;
const COLD_RESOURCE_CONNECT_RETRY_DELAYS_MS = [250, 1_000, 4_000] as const;

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

// The session UUID embedded in a fresh-session-screenshot resource URI
// (`automobile:device-session/<uuid>/screenshot`), or undefined for any other
// URI. Kept in lockstep with {@link isFreshSessionScreenshotUri}.
function freshSessionScreenshotUriSessionUuid(uri: string): string | undefined {
  const match = uri.match(/^automobile:device-session\/([^/]+)\/screenshot$/);
  return match?.[1];
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
    const restartCommand = params.clientBuild?.entryScript
      ? `${shellQuote(process.execPath)} ${shellQuote(params.clientBuild.entryScript)} --daemon restart`
      : installableVersion.length > 0 && installableVersion !== "unknown"
        ? `bunx @kaeawc/auto-mobile@${installableVersion} --daemon restart`
        : "the same installed auto-mobile package";
    const retryGuidance =
      params.retryAfterMs !== undefined
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
export class DaemonBoundSessionExpiredError extends Error {
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
        "Call getAndroid, getApple, or startDevice to acquire a new device session.",
    );
    this.name = "DaemonConnectionSessionReleasedError";
    this.reason = reason;
  }
}

/**
 * Raised when a tool the frontend advertises is rejected by the daemon as
 * "Unknown tool" even after the proxy reconciled build identity and retried.
 * Replaces the opaque `-32603` with an actionable message naming both builds.
 */
export class DaemonToolUnavailableError extends Error {
  readonly toolName: string;
  readonly clientBuildId: string;
  readonly daemonBuildId: string;

  constructor(params: { toolName: string; client: BuildIdentity; daemon: BuildIdentity }) {
    super(
      `Tool "${params.toolName}" is advertised by this AutoMobile client but the connected daemon ` +
        `does not provide it, even after restarting and refreshing the tool list. This usually means a ` +
        `wrong-build daemon is serving this frontend. ` +
        `client build=${describeBuildIdentity(params.client)}, ` +
        `daemon build=${describeBuildIdentity(params.daemon)}. ` +
        `Restart the daemon from this checkout to resolve the skew.`,
    );
    this.name = "DaemonToolUnavailableError";
    this.toolName = params.toolName;
    this.clientBuildId = params.client.buildId;
    this.daemonBuildId = params.daemon.buildId;
  }
}

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
  /** Custom daemon manager (for testing) */
  daemonManager?: DaemonManagerLike;
  /** Options to pass when auto-starting the daemon */
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
   * Supplies the static tool surface served by `listAdvertisedTools()` before a
   * daemon connection exists (issue #5879). Defaults to the committed
   * `schemas/tool-definitions.json`; injectable for testing.
   */
  staticToolDefinitionsProvider?: () => ProxiedToolDefinition[];
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
 * every feature-flag CLI override, marker-based eventAll promotion config, plus every
 * output-reduction flag. A
 * same-build MCP client that requests one of these against an already-running
 * daemon started without it (or vice versa) would otherwise silently get the
 * wrong tool-output or inputText behavior until a manual restart (issue #2759 —
 * the `toolResultsNoStructuredContent` case). `debug`, `embeddedSdk`, and `networkMockable`
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
  ...OUTPUT_REDUCTION_FLAG_SPECS.map((spec) => spec.field),
];

const REUSE_CRITICAL_STRING_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "toolOutputsDir",
  "accessibilityLevel",
  "accessibilityFailureMode",
  "accessibilityMinSeverity",
];

const REUSE_CRITICAL_NUMBER_OPTION_KEYS: (keyof DaemonOptions)[] = ["runnerReadinessTimeoutMs"];
export const REUSE_CRITICAL_ARRAY_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "enabledTools",
  "disabledTools",
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

function applyExactToolSelections(
  assignments: Map<string, boolean>,
  options: DaemonOptions | undefined,
): void {
  for (const toolName of stringArrayOption(options, "enabledTools") ?? []) {
    assignments.set(toolName, true);
  }
  for (const toolName of stringArrayOption(options, "disabledTools") ?? []) {
    assignments.set(toolName, false);
  }
}

function exactToolSelectionDeficits(
  requested: DaemonOptions | undefined,
  running: DaemonOptions | undefined,
): string[] {
  const requestedAssignments = new Map<string, boolean>();
  const runningAssignments = new Map<string, boolean>();
  applyExactToolSelections(requestedAssignments, requested);
  applyExactToolSelections(runningAssignments, running);
  return Array.from(requestedAssignments).flatMap(([toolName, enabled]) =>
    runningAssignments.get(toolName) === enabled
      ? []
      : [
          `${enabled ? "enabledTools" : "disabledTools"} ` +
            `(tool=${toolName}, requested=${enabled ? "enabled" : "disabled"}, ` +
            `running=${
              runningAssignments.has(toolName)
                ? runningAssignments.get(toolName)
                  ? "enabled"
                  : "disabled"
                : "unset"
            })`,
        ],
  );
}

function mergedExactToolSelections(
  running: DaemonOptions | undefined,
  requested: DaemonOptions | undefined,
): Pick<DaemonOptions, "enabledTools" | "disabledTools"> | undefined {
  const selectionsSpecified = REUSE_CRITICAL_ARRAY_OPTION_KEYS.some(
    (key) =>
      stringArrayOption(running, key) !== undefined ||
      stringArrayOption(requested, key) !== undefined,
  );
  if (!selectionsSpecified) {
    return undefined;
  }
  const assignments = new Map<string, boolean>();
  applyExactToolSelections(assignments, running);
  applyExactToolSelections(assignments, requested);
  return {
    enabledTools: Array.from(assignments)
      .filter(([, enabled]) => enabled)
      .map(([toolName]) => toolName),
    disabledTools: Array.from(assignments)
      .filter(([, enabled]) => !enabled)
      .map(([toolName]) => toolName),
  };
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
 * Booleans are compared strictly (`=== true`), so `undefined` and `false` both
 * read as "no opinion"; strings and marker arrays count only when the client
 * supplies one that differs from the daemon's. Exact-tool defaults are checked
 * assignment by assignment, so a running daemon may retain additional choices.
 * Returns a human-readable list (empty when the daemon already satisfies every
 * requested flag) for logging and error messages.
 */
function startupOptionDeficits(
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
    ...exactToolSelectionDeficits(requested, running),
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
 * active boolean on the running daemon is force-preserved.
 */
function mergeDaemonOptions(
  running: DaemonOptions | undefined,
  requested: DaemonOptions | undefined,
): DaemonOptions {
  const runningOptions = running ?? {};
  const requestedOptions = requested ?? {};
  const merged: DaemonOptions = { ...runningOptions, ...requestedOptions };
  const mergedRecord = merged as Record<string, unknown>;
  for (const [key, value] of Object.entries(runningOptions)) {
    if (value === true) {
      mergedRecord[key] = true;
    }
  }
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
  const exactToolSelections = mergedExactToolSelections(running, requested);
  if (exactToolSelections) {
    Object.assign(merged, exactToolSelections);
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
  private readonly timer: Timer;
  private readonly heartbeatKeeper: SingleFlightInterval;
  /**
   * Whether the recurring bound-session heartbeat keeper has been started for the
   * current binding. Gates the awaited establishment heartbeat (issue #5637) to
   * the FIRST connection only: once the keeper is running it owns every
   * subsequent tick, so a later reconnect must not send an extra, un-coalesced
   * heartbeat.
   */
  private heartbeatKeeperStarted = false;
  private readonly buildIdentity: BuildIdentity;
  private readonly clientVersion: string;
  private readonly clientAssetVersion: string | null;
  private connecting: Promise<void> | null = null;
  private connectionCloseReject: ((reason?: unknown) => void) | null = null;
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

  // Cached definitions from daemon
  private cachedTools: ProxiedToolDefinition[] | null = null;
  private cachedResources: ProxiedResourceDefinition[] | null = null;
  private cachedResourceTemplates: ProxiedResourceTemplate[] | null = null;

  // Listeners for daemon-forwarded list-changed notifications (issue #3223),
  // fired after the matching cache is invalidated so a re-fetch is never stale.
  private readonly listChangedListeners = new Set<(kind: ListChangedKind) => void>();
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
    this.timer = config.timer ?? defaultTimer;
    this.heartbeatKeeper = new SingleFlightInterval(
      this.timer,
      heartbeatIntervalMs(config),
      () => this.sendBoundSessionHeartbeat(),
      {
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
    }
    this.staticToolDefinitionsProvider =
      config.staticToolDefinitionsProvider ?? getStaticToolDefinitions;
    this.buildIdentity = config.buildIdentity ?? getCurrentBuildIdentity();
    this.clientVersion = config.clientVersion ?? DAEMON_VERSION;
    this.clientAssetVersion = isExplicitPin() ? resolveAssetVersion(resolvePinnedVersion()) : null;
  }

  /**
   * Ensure we have a connection to the daemon
   * Will auto-start daemon if configured and daemon is not running
   */
  async ensureConnected(): Promise<void> {
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    if (this.connected && this.client) {
      return;
    }

    // Prevent multiple concurrent connection attempts
    if (this.connecting) {
      return this.connecting;
    }

    const attempt = this.doConnect();
    const connecting = new Promise<void>((resolve, reject) => {
      this.connectionCloseReject = reject;
      void attempt.then(resolve, reject);
    });
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) {
        this.connecting = null;
        this.connectionCloseReject = null;
      }
    }
  }

  private throwIfClosing(): void {
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
  }

  private async doConnect(): Promise<void> {
    this.throwIfClosing();
    // Check if daemon is available
    const socketPath = this.config.socketPath ?? SOCKET_PATH;
    // This is an observation-only probe. A daemon from another checkout may own
    // this namespace's socket without its PID record; cleaning the path before
    // DaemonManager can verify that candidate would sever a live daemon.
    const isAvailable = await DaemonClient.isAvailable(socketPath, { skipStaleCleanup: true });

    if (!isAvailable) {
      if (!this.config.autoStartDaemon) {
        throw new DaemonUnavailableError("Daemon is not running and auto-start is disabled");
      }
      logger.info("[DaemonMcpProxy] Daemon not available, starting daemon...");
      await this.startDaemon();
      await this.ensureVersionMatches();
      await this.ensureAssetVersionPinMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    } else {
      await this.ensureVersionMatches();
      await this.ensureAssetVersionPinMatches();
      await this.ensureBuildMatches();
      await this.ensureStartupOptionsMatch();
    }

    // Create and connect client
    this.throwIfClosing();
    this.client = this.clientFactory();
    const client = this.client;
    // Wire daemon-pushed list-changed forwarding (issue #3223) when the client
    // supports it. The handler is registered BEFORE connect so no early frame
    // is dropped; the opt-in subscription request goes out after connect.
    const supportsNotifications =
      typeof client.onNotification === "function" &&
      typeof client.subscribeToNotifications === "function";
    if (supportsNotifications) {
      this.notificationUnsubscribe?.();
      this.notificationUnsubscribe = client.onNotification!((notification) =>
        this.handleDaemonNotification(notification),
      );
    }
    this.subscribeToClientConnectionClosed(client);
    await client.connect();
    if (this.closing) {
      await client.close();
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    logger.info("[DaemonMcpProxy] Connected to daemon");

    // Deliver the ownership heartbeat FIRST — before the best-effort notification
    // subscription (issue #5637). subscribeToNotifications() is a daemon RPC that
    // can stall up to the connection timeout; awaiting it before the heartbeat
    // would let the pre-first-heartbeat reclaim reap a bound session near the
    // grace edge before the heartbeat is even sent. The notification handler is
    // already registered above (before connect), so a session-released frame is
    // still handled during the heartbeat even without the opt-in subscription.
    //
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
    await this.establishBoundSessionHeartbeat();
    // Re-check closing before the deferred flip: the establishment heartbeat awaits a
    // real daemon round-trip, and a close() landing during it already set
    // connected=false and nulled the client. Without this guard doConnect would
    // resume and set connected=true again — leaving a stale connected flag over a
    // closed transport (the old pre-await placement flipped before this await, so
    // close() ran last). Mirrors the closing rechecks above.
    this.throwIfClosing();
    this.connected = true;
    this.cancelBackgroundConnectRetry();

    if (supportsNotifications) {
      try {
        await client.subscribeToNotifications!();
      } catch (error) {
        // Best-effort: without the subscription the proxy degrades to the old
        // cached behavior instead of failing the connection. Unexpected against
        // a same-version daemon (the handshake gate pins versions), so warn.
        logger.warn(`[DaemonMcpProxy] Failed to subscribe to daemon notifications: ${error}`);
      }
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

  // Invalidate the matching cache and re-emit a list_changed to listeners,
  // mirroring the daemon-pushed invalidation path (see handleDaemonNotification)
  // so a re-fetch is never stale.
  private notifyListChanged(kind: ListChangedKind): void {
    this.discoveryEpoch += 1;
    if (kind === "tools") {
      this.cachedTools = null;
    } else {
      this.cachedResources = null;
      this.cachedResourceTemplates = null;
    }
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

  private handleDaemonNotification(notification: DaemonNotification): void {
    if (notification.method === SESSION_RELEASED_NOTIFICATION_METHOD) {
      this.handleSessionReleasedNotification(notification);
      return;
    }

    const kind = listChangedKindForMethod(notification.method);
    if (kind === undefined) {
      // Unknown pushed methods are expected as the daemon grows new
      // notification families; ignoring keeps old proxies forward-compatible.
      logger.debug(`[DaemonMcpProxy] Ignoring unknown daemon notification: ${notification.method}`);
      return;
    }

    // Bump the discovery epoch so a discovery request whose response is still in
    // flight declines to repopulate the cache this invalidation just cleared
    // (issue #4655).
    this.discoveryEpoch += 1;
    if (kind === "tools") {
      this.cachedTools = null;
    } else {
      this.cachedResources = null;
      this.cachedResourceTemplates = null;
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
    this.recordSessionReleased(releasedSessionUuid, notification.reason);
    // A released session is no longer owned: drop it so a later fresh-screenshot
    // read stops owner-routing to it and falls back to the live binding (which the
    // daemon denies), matching the "released session remains denied" guarantee
    // (issue #5663).
    this.ownedDeviceSessions.delete(releasedSessionUuid);
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

  /**
   * Ensure the client never attaches to a daemon running a different package version.
   * Newer clients may restart older daemons, but every mismatch remains a hard gate.
   */
  private async ensureVersionMatches(): Promise<void> {
    const status = await this.daemonManager.status();
    if (!status.running) {
      return;
    }

    const runningVersion = status.version?.trim() ?? "";
    if (runningVersion === this.clientVersion) {
      return;
    }

    // The release portions (before the `+g<sha>` dev stamp) drive the
    // newer/older decision. A plain release client intentionally matches a
    // source-stamped daemon at that release; two stamped versions still detect
    // source-checkout dev-skew.
    const runningBase = releaseVersion(runningVersion);
    const clientBase = releaseVersion(this.clientVersion);
    const sameRelease = runningBase === clientBase;
    const clientDeclaresFullVersion = clientBase !== this.clientVersion;

    if (sameRelease && !clientDeclaresFullVersion) {
      return;
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

    // Reach here when the client is strictly newer OR the daemon is a same-release
    // dev-skew (different git stamp). Both reconcile by restarting the daemon from
    // this client's build. Same-release dev-skew must be handled HERE rather than
    // deferred to ensureBuildMatches: the build-identity hash covers only the entry
    // script (process.argv[1]), so in unbundled source-mode runs (`bun src/index.ts`)
    // it is blind to commits that change non-entry files — the git stamp is the only
    // signal. The restart is cooldown-bounded below so two checkouts cannot thrash.

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

    logger.info(
      `[DaemonMcpProxy] Daemon version ${runningVersion || "unknown"} differs from MCP server ${this.clientVersion}, restarting daemon`,
    );
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    await this.daemonManager.restart(mergeDaemonOptions(status.options, this.config.daemonOptions));
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.invalidateCache();
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    const restartedStatus = await this.daemonManager.status();
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
    const status = await this.daemonManager.status();
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
  private async ensureBuildMatches(): Promise<void> {
    const status = await this.daemonManager.status();
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

    logger.info(
      `[DaemonMcpProxy] Daemon build ${daemonIdentity.buildId} (${daemonIdentity.entryScript || "unknown"}) differs from client build ${this.buildIdentity.buildId} (${this.buildIdentity.entryScript || "unknown"}), restarting daemon`,
    );
    // Preserve the running daemon's existing options across the restart rather
    // than resetting to this client's config, which would strip flags the
    // daemon was launched with when the connecting client is bare (issue #3846).
    await this.daemonManager.restart(mergeDaemonOptions(status.options, this.config.daemonOptions));
    // The replacement daemon may expose a different tool set; drop the cache so we
    // never advertise the old daemon's tools against the new build.
    this.invalidateCache();
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    const restartedStatus = await this.daemonManager.status();
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
    const status = await this.daemonManager.status();
    if (!status.running) {
      return;
    }

    const requested = this.config.daemonOptions;
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
    // Preserve the running daemon's existing options and add the requested ones
    // so the restart gains the missing flag without stripping any the daemon
    // already had (issue #3846).
    await this.daemonManager.restart(mergeDaemonOptions(status.options, requested));
    const ready = await this.daemonManager.waitForReady(DAEMON_STARTUP_TIMEOUT_MS);
    if (!ready) {
      throw new DaemonUnavailableError(
        `Daemon failed to restart within ${DAEMON_STARTUP_TIMEOUT_MS}ms`,
      );
    }

    const restartedStatus = await this.daemonManager.status();
    const remaining = startupOptionDeficits(requested, restartedStatus.options);
    if (!restartedStatus.running || remaining.length > 0) {
      throw new DaemonUnavailableError(
        `Daemon restart completed but startup options still differ (${remaining.join(", ")})`,
      );
    }
  }

  /**
   * Start the daemon process
   */
  private async startDaemon(): Promise<void> {
    const status = await this.daemonManager.status();

    if (!status.running) {
      logger.info("[DaemonMcpProxy] Starting daemon...");
      // Pass through daemon options (debug flags, video defaults, etc.)
      await this.daemonManager.start(this.config.daemonOptions ?? {});

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
  ): Promise<T> {
    if (this.closing) {
      throw new DaemonUnavailableError("MCP proxy is closing");
    }
    this.throwIfBoundSessionFenced(allowReleasedSession);
    await this.ensureConnected();
    this.throwIfBoundSessionFenced(allowReleasedSession);

    try {
      return await operation();
    } catch (error) {
      if (this.closing) {
        throw error;
      }
      this.throwIfBoundSessionFenced(allowReleasedSession);
      if (!this.isRecoverableDaemonSessionError(error)) {
        throw error;
      }

      logger.warn(
        `[DaemonMcpProxy] Daemon session is stale, reconnecting and retrying once: ${errorMessage(error)}`,
      );
      await this.resetConnection();
      this.throwIfBoundSessionFenced(allowReleasedSession);
      await this.ensureConnected();
      this.throwIfBoundSessionFenced(allowReleasedSession);
      try {
        return await operation();
      } catch (retryError) {
        this.throwIfBoundSessionFenced(allowReleasedSession);
        if (
          attemptedSessionUuid &&
          this.boundSessionUuid === attemptedSessionUuid &&
          this.isDaemonSessionNotFoundError(retryError)
        ) {
          this.fenceBoundSessionUuid(attemptedSessionUuid, "session-not-found");
          throw this.boundSessionExpiredError();
        }
        throw retryError;
      }
    }
  }

  private isRecoverableDaemonSessionError(error: unknown): boolean {
    if (error instanceof DaemonUnavailableError) {
      return true;
    }

    // "Unknown tool" means the frontend advertised a tool the daemon rejects —
    // typically a wrong-build daemon serving this frontend. Reconnecting drops the
    // stale tool cache and re-runs the build-identity handshake (which restarts the
    // daemon to the correct build on skew), so retry once before giving up.
    return this.isDaemonSessionNotFoundError(error) || this.isUnknownToolError(error);
  }

  private isDaemonSessionNotFoundError(error: unknown): boolean {
    const message = errorMessage(error);
    return message.includes("Session not found");
  }

  private isUnadmittedDaemonSessionError(error: unknown): boolean {
    return errorMessage(error).includes("is not an active daemon session");
  }

  private isUnknownToolError(error: unknown): boolean {
    const message = errorMessage(error);
    return message.includes("Unknown tool:");
  }

  private shouldSkipLeaseRefreshForDeviceControlTransportError(error: unknown): boolean {
    return (
      error instanceof DeviceControlTransportError &&
      (error.failure.phase === "connect" || !error.failure.sessionValid)
    );
  }

  private async resetConnection(): Promise<void> {
    const staleClient = this.client;
    this.connected = false;
    this.client = null;
    this.notificationUnsubscribe?.();
    this.notificationUnsubscribe = null;
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = null;
    this.invalidateCache();

    if (!staleClient) {
      return;
    }

    try {
      await staleClient.close();
    } catch (error) {
      logger.warn(`[DaemonMcpProxy] Failed to close stale daemon client: ${error}`);
    }
  }

  private subscribeToClientConnectionClosed(client: DaemonClientLike): void {
    if (typeof client.onConnectionClosed !== "function") {
      return;
    }
    this.connectionClosedUnsubscribe?.();
    this.connectionClosedUnsubscribe = client.onConnectionClosed(() => {
      if (this.client === client) {
        void this.resetConnection();
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
   * Once a connection is established, it delegates to {@link listTools} so the
   * accurate (session-scoped) list is served. The first successful connect after
   * a static serve emits a tools `list_changed` (see {@link doConnect}) so the
   * client re-fetches and reconciles any difference.
   *
   * The static path deliberately does NOT call `throwIfBoundSessionUnavailable()`
   * (unlike {@link listTools}): re-coupling `tools/list` to daemon/session state
   * is exactly what issue #5879 removes. A fenced/expired bound session still
   * surfaces its ownership-lost error on the next actual tool call, which routes
   * through {@link callTool}'s gate.
   */
  async listAdvertisedTools(): Promise<ProxiedToolDefinition[]> {
    if (this.connected && this.client) {
      return this.listTools();
    }
    this.servedStaticToolList = true;
    return this.staticToolDefinitionsProvider();
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
    if (this.connecting || this.backgroundConnectRetry || this.closing) {
      return;
    }
    void this.ensureBackgroundResourceConnection();
  }

  private async ensureBackgroundResourceConnection(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (error) {
      // Best-effort: the cold roster already returned, and the tool surface is
      // visible via tools/list. A wedged/absent daemon must not surface here; the
      // the next actual request still reports the failure to the client. Retry
      // transient failures a bounded number of times for resource-only clients.
      logger.debug(
        `[DaemonMcpProxy] background connect after cold resource discovery failed: ${error}`,
      );
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

  /**
   * Get list of available tools from daemon
   */
  async listTools(): Promise<ProxiedToolDefinition[]> {
    this.throwIfBoundSessionUnavailable();
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
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = this.withToolSelectionProfile(this.withBoundSessionUuid({}));
      const result = await this.withRecoverableReconnect(
        () => this.client!.callDaemonMethod("tools/list", forwardedParams),
        this.sessionUuidFromArgs(forwardedParams),
      );
      const tools = result?.tools ?? [];
      // If a list_changed or bound-session release invalidated this cache WHILE the
      // response was in flight, the response is scoped to the now-stale binding.
      // Return it to THIS caller but leave the cache empty so the next listTools()
      // refetches under the current scope, instead of resurrecting the list the
      // invalidation just cleared (issue #4655).
      if (this.discoveryEpoch === discoveryEpoch) {
        this.cachedTools = tools;
      }
      return tools;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list tools: ${error}`);
      throw error;
    }
  }

  /**
   * Call a tool on the daemon
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    // Device-session acquisition (getAndroid/getApple/startDevice) mints a NEW
    // session in its RESULT and is never routed to — or fenced by — the connection's
    // bound session: it must be admitted even on a terminally fenced connection so
    // the client can recover in-band (issue #5689). Forward its raw args and bind
    // the minted session from the result afterwards.
    const isSessionAcquisition = isDeviceSessionAcquisitionTool(name);
    // An omitted `sessionUuid` on the control tool means the connection profile,
    // not the proxy's retained device-routing session. Preserve that distinction
    // after a device has been bound.
    const routingArgs =
      name === SET_TOOL_ENABLED_TOOL_NAME || isSessionAcquisition
        ? args
        : this.withBoundSessionUuid(args);
    const forwardedArgs = this.withToolSelectionProfile(routingArgs);
    const forwardedSessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    this.retainReleaseEpochReference(forwardedSessionUuid);
    // Snapshot the release epoch at forward time. If a session-released signal for
    // the SPECIFIC forwarded UUID lands WHILE this call is in flight, that UUID's
    // recorded epoch advances past this snapshot and the completion path below
    // declines to resurrect the released UUID (issue #4611/#4655). A release of an
    // UNRELATED session bumps the global epoch but not the forwarded UUID's entry,
    // so it does not block remembering the session this call forwarded.
    const callReleaseEpoch = this.releaseEpoch;
    try {
      const result = await this.withRecoverableReconnect(
        () => {
          this.throwIfForwardedSessionReleasedSince(forwardedArgs, callReleaseEpoch);
          return this.client!.callTool(name, forwardedArgs);
        },
        forwardedSessionUuid,
        // Acquisition is admitted while fenced; the terminal fence is cleared once
        // the result-minted session establishes a fresh binding.
        isSessionAcquisition,
      );
      if (result?.isError) {
        this.refreshReplayLeaseForBoundSessionResult(forwardedArgs, callReleaseEpoch);
        return result;
      }
      this.rememberToolSelectionProfile(name, args, result);
      if (isSessionAcquisition) {
        await this.bindResultMintedDeviceSession(name, result);
        return result;
      }
      // Remember what was actually forwarded, not the caller's raw args. An
      // implicit sessionless call injects the bound UUID into forwardedArgs and
      // extends the live daemon session in getOrCreateSession(); refreshing the
      // replay lease off forwardedArgs keeps continuous implicit activity from
      // being mistaken for idleness, so a later reconnect re-seeds the still-live
      // session instead of creating an unseeded transport (issue #4610).
      this.rememberSessionUuid(name, forwardedArgs, callReleaseEpoch);
      return result;
    } catch (error) {
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
        throw await this.toolUnavailableError(name);
      }
      throw error;
    } finally {
      this.releaseReleaseEpochReference(forwardedSessionUuid);
    }
  }

  private withBoundSessionUuid(args: Record<string, unknown>): Record<string, unknown> {
    // A daemon session released by ordinary heartbeat/idle expiry leaves this
    // remembered binding dangling; replaying its UUID on a later sessionless call
    // would silently recreate the session and reacquire a device without the
    // caller asking for it (issue #4610). Once the replay window has elapsed with
    // no forwarded call (explicit or implicit) refreshing the binding, treat it
    // as retired.
    const explicitSessionUuid = this.sessionUuidFromArgs(args);
    this.throwIfBoundSessionUnavailable(explicitSessionUuid);
    const normalizedArgs =
      explicitSessionUuid && explicitSessionUuid !== args.sessionUuid
        ? { ...args, sessionUuid: explicitSessionUuid }
        : args;
    if (!this.boundSessionUuid || explicitSessionUuid === this.boundSessionUuid) {
      if (explicitSessionUuid === this.boundSessionUuid && this.boundSessionUuid) {
        return {
          ...normalizedArgs,
          [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid,
        };
      }
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
    return {
      ...args,
      sessionUuid: this.boundSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: this.boundSessionUuid,
    };
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
    const callerReferencedTerminal =
      !terminal.fromResultMint ||
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
    const hasExplicitSessionUuid =
      typeof requestedArgs.sessionUuid === "string" && requestedArgs.sessionUuid.trim().length > 0;
    if (!hasExplicitSessionUuid) {
      const sessionUuid = toolSelectionProfileUuidFromResponse(result);
      if (sessionUuid) {
        this.toolSelectionProfileUuid = sessionUuid;
      }
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
  }

  private fenceBoundSessionUuid(
    sessionUuid: string,
    reason: string,
    release?: SessionReleaseSnapshot,
  ): void {
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
    void this.stopBoundSessionHeartbeat();
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

  private startBoundSessionHeartbeat(): void {
    if (
      this.boundSessionUuid &&
      !this.terminalBoundSession &&
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
    if (!sessionUuid || this.terminalBoundSession || this.closing || !this.client) {
      return;
    }
    try {
      await this.client.callDaemonMethod("daemon/heartbeat", { sessionId: sessionUuid });
      if (this.boundSessionUuid === sessionUuid && !this.terminalBoundSession) {
        this.boundSessionUuidAt = this.timer.now();
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

  private async stopBoundSessionHeartbeat(): Promise<void> {
    const settled = await this.heartbeatKeeper.stop();
    this.heartbeatKeeperStarted = false;
    if (!settled) {
      logger.warn("[DaemonMcpProxy] Bound-session heartbeat did not settle before shutdown");
    }
  }

  private async sendBoundSessionHeartbeat(): Promise<void> {
    const sessionUuid = this.boundSessionUuid;
    if (!sessionUuid || this.terminalBoundSession || this.closing) {
      return;
    }
    try {
      await this.withRecoverableReconnect(
        () => this.client!.callDaemonMethod("daemon/heartbeat", { sessionId: sessionUuid }),
        sessionUuid,
      );
    } catch (error) {
      if (error instanceof DaemonBoundSessionExpiredError) {
        // Terminal fencing already stopped the keeper; this tick has no further work.
        logger.debug(`[DaemonMcpProxy] Bound-session heartbeat stopped: ${error.message}`);
        return;
      }
      throw error;
    }
    if (this.boundSessionUuid === sessionUuid && !this.terminalBoundSession) {
      this.boundSessionUuidAt = this.timer.now();
    }
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
    if (!this.activeReleaseEpochReferences.has(normalizedSessionUuid)) {
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
    this.releasedSessionEpochs.delete(sessionUuid);
    this.releasedSessionReasons.delete(sessionUuid);
  }

  private forwardedSessionReleaseReasonSince(
    forwardedArgs: Record<string, unknown>,
    forwardEpoch: number,
  ): string | undefined {
    const forwardedUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (!forwardedUuid || (this.releasedSessionEpochs.get(forwardedUuid) ?? 0) <= forwardEpoch) {
      return undefined;
    }
    return this.releasedSessionReasons.get(forwardedUuid) ?? "released";
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

  // Bind and heartbeat the device session a getAndroid/getApple/startDevice call
  // minted in its RESULT — the proxy equivalent of the direct-path bind in
  // src/server/index.ts. Without this the daemon never sees an ownership heartbeat
  // for a result-minted session and reaps it under the pre-first-heartbeat grace
  // (issue #5689). Acquisition also clears any terminal fence: the connection is
  // usable again once a fresh session is established (AC2).
  private async bindResultMintedDeviceSession(name: string, result: unknown): Promise<void> {
    if (!isDeviceSessionAcquisitionTool(name)) {
      return;
    }
    const mintedSessionUuid = getDeviceSessionIdFromResult(result);
    if (!mintedSessionUuid || mintedSessionUuid === this.boundSessionUuid) {
      return;
    }
    // A prior binding's keeper must not outlive the rebind to a fresh session.
    // (A terminal fence already stopped it; this covers re-acquiring over a live
    // binding.)
    if (this.heartbeatKeeperStarted) {
      await this.stopBoundSessionHeartbeat();
    }
    this.terminalBoundSession = undefined;
    this.boundSessionUuid = mintedSessionUuid;
    this.boundSessionUuidAt = this.timer.now();
    this.ownedDeviceSessions.add(mintedSessionUuid);
    this.boundSessionFromResultMint = true;
    this.initialSessionBindingConfigured = false;
    // Deliver the first ownership heartbeat as part of the acquisition so the
    // daemon records ownership before the pre-first-heartbeat grace fires
    // (mirrors the establishment guarantee in issue #5637).
    await this.establishBoundSessionHeartbeat();
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
    if (rememberedSessionUuid && this.toolAcceptsSessionUuid(name)) {
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
      this.boundSessionFromResultMint = false;
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
      this.isRecoverableDaemonSessionError(error) ||
      this.isUnadmittedDaemonSessionError(error) ||
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

  private refreshReplayLeaseForBoundSessionResult(
    forwardedArgs: Record<string, unknown>,
    callReleaseEpoch: number,
  ): void {
    const releaseReason = this.forwardedSessionReleaseReasonSince(forwardedArgs, callReleaseEpoch);
    if (releaseReason) {
      this.fenceReleasedForwardedSession(forwardedArgs, releaseReason);
      return;
    }
    const forwardedSessionUuid = this.sessionUuidFromArgs(forwardedArgs);
    if (forwardedSessionUuid && forwardedSessionUuid === this.boundSessionUuid) {
      this.updateBoundSessionUuid(forwardedSessionUuid);
      this.startBoundSessionHeartbeat();
    }
  }

  private async toolUnavailableError(name: string): Promise<DaemonToolUnavailableError> {
    let daemonIdentity: BuildIdentity = { entryScript: "", buildId: "unknown" };
    try {
      const status = await this.daemonManager.status();
      daemonIdentity = buildIdentityFromStatus(status);
    } catch (error) {
      logger.warn(
        `[DaemonMcpProxy] Failed to read daemon status for tool-unavailable error: ${error}`,
      );
    }
    return new DaemonToolUnavailableError({
      toolName: name,
      client: this.buildIdentity,
      daemon: daemonIdentity,
    });
  }

  /**
   * Get list of available resources from daemon
   */
  async listResources(): Promise<ProxiedResourceDefinition[]> {
    this.throwIfBoundSessionUnavailable();
    // Return cached resources if available
    if (this.cachedResources) {
      return this.cachedResources;
    }

    try {
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = this.withBoundSessionUuid({});
      const result = await this.withRecoverableReconnect(
        () => this.client!.callDaemonMethod("resources/list", forwardedParams),
        this.sessionUuidFromArgs(forwardedParams),
      );
      const resources = result?.resources ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResources() refetches.
      if (this.discoveryEpoch === discoveryEpoch) {
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
    this.throwIfBoundSessionUnavailable();
    // Return cached templates if available
    if (this.cachedResourceTemplates) {
      return this.cachedResourceTemplates;
    }

    try {
      const discoveryEpoch = this.discoveryEpoch;
      const forwardedParams = this.withBoundSessionUuid({});
      const result = await this.withRecoverableReconnect(
        () => this.client!.callDaemonMethod("resources/list-templates", forwardedParams),
        this.sessionUuidFromArgs(forwardedParams),
      );
      const templates = result?.resourceTemplates ?? [];
      // Discard a response invalidated mid-flight rather than caching the stale
      // scope (issue #4655); the next listResourceTemplates() refetches.
      if (this.discoveryEpoch === discoveryEpoch) {
        this.cachedResourceTemplates = templates;
      }
      return templates;
    } catch (error) {
      logger.error(`[DaemonMcpProxy] Failed to list resource templates: ${error}`);
      throw error;
    }
  }

  // Route a fresh-session-screenshot read to the session named in its URI when
  // this connection owns that session but has since bound a newer one (e.g.
  // getApple after getAndroid). Forwarding the URI's session — not the latest
  // binding — makes the daemon seed the loopback SessionToolBinding with the
  // owning session, so the just-established owner is authorized instead of denied
  // with SCREENSHOT_ACCESS_DENIED (issue #5663). Returns undefined for any other
  // URI, a foreign/unowned session (which must keep forwarding this connection's
  // own binding and stay denied), or the current binding / a fenced connection
  // (both already handled by withBoundSessionUuid and the released-session path).
  private freshScreenshotOwnerForwardParams(uri: string): Record<string, unknown> | undefined {
    if (this.terminalBoundSession) {
      return undefined;
    }
    const uriSessionUuid = freshSessionScreenshotUriSessionUuid(uri);
    if (
      !uriSessionUuid ||
      uriSessionUuid === this.boundSessionUuid ||
      !this.ownedDeviceSessions.has(uriSessionUuid)
    ) {
      return undefined;
    }
    return {
      sessionUuid: uriSessionUuid,
      [DAEMON_BOUND_SESSION_PARAM]: uriSessionUuid,
    };
  }

  /**
   * Read a resource from the daemon
   */
  async readResource(uri: string): Promise<any> {
    const terminalSessionUuid = this.terminalBoundSession?.sessionUuid;
    // A tool-output artifact read is session-independent, so it survives a
    // terminal release without any session params at all (issue #5917). The
    // fresh-screenshot exemption, by contrast, must still target the released
    // session it belongs to.
    const isToolOutput = isToolOutputResourceUri(uri);
    const allowReleasedSession =
      isToolOutput ||
      (terminalSessionUuid !== undefined && isFreshSessionScreenshotUri(uri, terminalSessionUuid));
    const forwardedParams = isToolOutput
      ? {}
      : allowReleasedSession
        ? {
            sessionUuid: terminalSessionUuid,
            [DAEMON_BOUND_SESSION_PARAM]: terminalSessionUuid,
            [DAEMON_RELEASED_SESSION_PARAM]: terminalSessionUuid,
          }
        : (this.freshScreenshotOwnerForwardParams(uri) ?? this.withBoundSessionUuid({}));
    return await this.withRecoverableReconnect(
      () => this.client!.readResource(uri, forwardedParams),
      this.sessionUuidFromArgs(forwardedParams),
      allowReleasedSession,
    );
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
    this.cancelBackgroundConnectRetry();
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
