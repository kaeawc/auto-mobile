import type { DeviceControlTransportFailure } from "./deviceControlTransportFailure";
import type { SessionReleaseSnapshot } from "./sessionManager";
import type { DaemonHandshakeFailure } from "./daemonHandshake";
import type { DaemonShuttingDownFailure } from "./daemonShutdownOutcome";
import type { McpOverloadFailure } from "./McpTimeoutError";
import type { SocketRequestAdmissionQueue } from "./socketRequestAdmission";

/**
 * Request sent from CLI client to daemon
 */
export interface DaemonRequest {
  /** Unique request ID for tracking */
  id: string;
  /** Request type */
  type: "mcp_request" | "daemon_request";
  /** MCP or daemon method name (e.g., "tools/call", "daemon/availableDevices") */
  method: string;
  /** MCP or daemon method parameters */
  params: any;
  /** Request timeout in milliseconds (optional, defaults to MCP SDK default of 60000) */
  timeoutMs?: number;
  /**
   * Client's package/release version, declared for the server-side handshake
   * gate (#2744). Optional so legacy clients that predate the gate still connect.
   */
  clientVersion?: string;
  /**
   * Content hash of the client's entry script (build identity). Only the
   * TypeScript client can compute this; Kotlin/Swift omit it and are gated on
   * {@link clientVersion} alone.
   */
  clientBuildId?: string;
  /** Absolute path to the client's entry script (build-identity fallback). */
  clientEntryScript?: string;
  /**
   * Echo of the MCP client's own `params._meta.progressToken` for a `tools/call`
   * request (issue #6205). When present the daemon relays `notifications/progress`
   * ticks for this call back to the requesting socket session carrying this SAME
   * token, mirroring the direct-server fix (#6118); when absent no progress is
   * relayed, never fabricated.
   */
  progressToken?: string | number;
}

/**
 * Response sent from daemon to CLI client
 */
export interface DaemonResponse {
  /** Request ID this response corresponds to */
  id: string | null;
  /** Response type */
  type: "mcp_response";
  /** Whether the request was successful */
  success: boolean;
  /** Result data if successful */
  result?: any;
  /** Error message if unsuccessful */
  error?: string;
  /** Structured daemon error code, or JSON-RPC parse/invalid-request code. */
  code?: string | number;
  /**
   * Why a session-not-found answer names a session the daemon knows it released (#10730), e.g.
   * `heartbeat-timeout`, `cleanup-expired` or `owner-disconnected`. Absent for a UUID the daemon
   * never issued. Additive: older clients ignore it.
   */
  releaseReason?: string;
  /** With `releaseReason`: the session was released by its idle window (#10832). Additive. */
  idle?: true;
  /** Rejected before any device operation was admitted. */
  handshakeFailure?: DaemonHandshakeFailure;
  /**
   * Safe, machine-readable details for a loopback device-control transport
   * failure. Optional so older Kotlin, Swift, and TypeScript clients keep using
   * the legacy string error without a wire-version break.
   */
  transportFailure?: DeviceControlTransportFailure;
  /**
   * Machine-readable terminal loss of the device session explicitly bound to
   * this request. This must never be mistaken for an expired loopback MCP
   * transport session and retried against a replacement daemon.
   */
  boundSessionLoss?: BoundSessionLoss;
  /** Retryable daemon lifecycle transition that rejected new session admission. */
  daemonShuttingDown?: DaemonShuttingDownFailure;
  /** Retryable rejection issued before a queue-depleted deadline expires. */
  overloadFailure?: McpOverloadFailure;
  /** Original timeout/abort reason retained when transport errors obscure it. */
  requestFailureCause?: DaemonRequestFailureCause;
  /**
   * Number of leading characters delivered by a failed Android
   * `input/typeText` append request. Present only when the append operation
   * reached the device before failing, or explicitly reports zero progress.
   */
  charsSent?: number;
}

export interface DaemonRequestFailureCause {
  name: string;
  message: string;
}

export function sanitizeDaemonRequestFailureCause(
  value: unknown,
): DaemonRequestFailureCause | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const cause = value as Record<string, unknown>;
  if (
    typeof cause.name !== "string" ||
    cause.name.length === 0 ||
    typeof cause.message !== "string" ||
    cause.message.length === 0
  ) {
    return undefined;
  }
  return { name: cause.name, message: cause.message };
}

export const DAEMON_SESSION_NOT_FOUND_CODE = "daemon_session_not_found";

export const DAEMON_LIVENESS_OWNER_SUPERSEDED_CODE = "liveness_owner_superseded";
/** A token-bearing keeper tick reached an unowned session; only an explicit claim can adopt it. */
export const DAEMON_LIVENESS_OWNER_UNOWNED_CODE = "liveness_owner_unowned";
/** Release authorization failed: the supplied token is not the current owner. */
export const DAEMON_LIVENESS_OWNER_NOT_OWNER_CODE = "liveness_owner_not_owner";

/**
 * A tool call reached a session whose owner's lease expired and that is held inside its suspect
 * window (#10051). Its owner can still restore it with a heartbeat, so a proxy treats this as
 * "recovery is still possible" rather than as a loss (#10053).
 */
export const DAEMON_SESSION_SUSPECT_CODE = "daemon_session_suspect";

/**
 * A heartbeat named the daemon process it expects (`expectedDaemonInstance`) and reached a
 * different one: the daemon was restarted. Nothing changed on the session (#10989).
 */
export const DAEMON_INSTANCE_CHANGED_CODE = "daemon_instance_changed";

/** A claim from a different token was rejected because the owner's lease is live (#10050). */
export const DAEMON_LIVENESS_OWNER_CONFLICT_CODE = "liveness_owner_conflict";

/**
 * An external `--daemon heartbeat` keeper tried to heartbeat or claim a session a stdio/HTTP proxy
 * owns. Liveness flows harness -> proxy -> daemon only, so the keeper is refused (#10054).
 */
export const DAEMON_LIVENESS_OWNER_IS_PROXY_CODE = "liveness_owner_is_proxy";
/**
 * The daemon registers the requested tool but its availability gate (debug-only,
 * embedded-SDK-only, plan-only) rejects the call. Carried as the response `code`
 * so the proxy never mistakes a gated tool for a stale daemon (issue #10177); a
 * reconnect cannot change a gate. Daemons that predate it send no code.
 */
export const DAEMON_TOOL_UNAVAILABLE_CODE = "daemon_tool_unavailable";

/** True for an error carrying the gate marker (a daemon response `code`, or the proxy's own error). */
export function isGatedToolErrorCode(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === DAEMON_TOOL_UNAVAILABLE_CODE
  );
}

export const BOUND_SESSION_LOSS_CODE = "bound_session_lost";

export interface BoundSessionLoss {
  code: typeof BOUND_SESSION_LOSS_CODE;
  sessionUuid: string;
  reason: string;
  /** Captured before the terminal session was removed, when still available. */
  release?: SessionReleaseSnapshot;
}

/** The daemon's `releaseReason` carried on a session-not-found error (#10730), when it sent one. */
export function releaseReasonFromError(error: unknown): string | undefined {
  if (error === null || typeof error !== "object" || !("releaseReason" in error)) {
    return undefined;
  }
  const { releaseReason } = error;
  return typeof releaseReason === "string" && releaseReason.length > 0 ? releaseReason : undefined;
}

/** Release reasons that mean the session ran out its idle window rather than being taken away. */
const IDLE_EXPIRY_LOSS_REASONS: ReadonlySet<string> = new Set([
  "lazy-expiry",
  "cleanup-expired",
  "cli-idle-timeout",
]);

/** Whether a release reason is an idle-window release (#10832), as opposed to a lapse or loss. */
export function isIdleReleaseReason(reason: string): boolean {
  return IDLE_EXPIRY_LOSS_REASONS.has(reason);
}

/**
 * The release fields of a session-not-found answer: the recorded `releaseReason` and, for an
 * idle-window release, `idle: true` so a client can tell "reacquire" from a restart or loss (#10832).
 */
export function releasedSessionNotFoundFields(releaseReason: string | undefined): {
  releaseReason?: string;
  idle?: true;
} {
  if (!releaseReason) {
    return {};
  }
  return isIdleReleaseReason(releaseReason) ? { releaseReason, idle: true } : { releaseReason };
}

const OWNER_DISCONNECTED_LOSS_REASON = "owner-disconnected";

function isDaemonRestartLossReason(reason: string): boolean {
  return reason === "daemon-shutdown" || reason.startsWith("device-restart");
}

/** The owner stopped heartbeating: its liveness lease lapsed, whatever its tool activity. */
const HEARTBEAT_TIMEOUT_LOSS_REASON = "heartbeat-timeout";

/**
 * The owner-facing message for a lost bound session. An idle expiry says so, including that the
 * wall-clock window keeps running while the host sleeps, so a call after a long sleep gets an
 * explanation and a next step rather than a bare "no longer active". A heartbeat timeout is not
 * idleness: the daemon stopped hearing the owner's liveness heartbeats on an awake host, and host
 * sleep never lapses a lease (#10699), so that message says so instead.
 */
export function boundSessionLossMessage(failure: BoundSessionLoss): string {
  const base = `Device session ${failure.sessionUuid} is no longer active (${failure.reason}). `;
  const next = "Acquire a new device session before continuing.";
  if (failure.reason === HEARTBEAT_TIMEOUT_LOSS_REASON) {
    return (
      `${base}The daemon stopped receiving this session's liveness heartbeats, so it released ` +
      `the device; check that the client process holding the session is still running. ${next}`
    );
  }
  if (failure.reason === OWNER_DISCONNECTED_LOSS_REASON) {
    return (
      `${base}The client connection that owned this session closed, so the daemon released the ` +
      `device. ${next}`
    );
  }
  if (isDaemonRestartLossReason(failure.reason)) {
    return (
      `${base}The daemon shut down or restarted, or the device restarted, and this session was ` +
      `not restored. ${next}`
    );
  }
  return IDLE_EXPIRY_LOSS_REASONS.has(failure.reason)
    ? `${base}The session was released after sitting idle past its window; time the host spent ` +
        `asleep counts toward that window. ${next}`
    : `${base}${next}`;
}

function hasSessionReleaseSnapshotFields(
  record: Record<string, unknown>,
  expectedSessionUuid: string,
): record is Record<string, unknown> &
  Pick<SessionReleaseSnapshot, "deviceId" | "releaseReason" | "releasedAtMs" | "terminal"> {
  return [
    record.sessionId === expectedSessionUuid,
    typeof record.deviceId === "string",
    typeof record.releaseReason === "string",
    typeof record.releasedAtMs === "number" && Number.isFinite(record.releasedAtMs),
    typeof record.terminal === "boolean",
  ].every(Boolean);
}

function isSessionReleaseHeartbeat(value: unknown): value is SessionReleaseSnapshot["heartbeat"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return [
    typeof record.lastHeartbeatMs === "number" && Number.isFinite(record.lastHeartbeatMs),
    typeof record.hasReceivedHeartbeat === "boolean",
    typeof record.timeoutMs === "number" && Number.isFinite(record.timeoutMs),
    typeof record.ageMs === "number" && Number.isFinite(record.ageMs),
  ].every(Boolean);
}

function sanitizeSessionReleaseSnapshot(
  value: unknown,
  expectedSessionUuid: string,
): SessionReleaseSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    !hasSessionReleaseSnapshotFields(record, expectedSessionUuid) ||
    !isSessionReleaseHeartbeat(record.heartbeat)
  ) {
    return undefined;
  }
  return {
    sessionId: expectedSessionUuid,
    deviceId: record.deviceId,
    releaseReason: record.releaseReason,
    releasedAtMs: record.releasedAtMs,
    terminal: record.terminal,
    ...(typeof record.ownerPid === "number" && Number.isInteger(record.ownerPid)
      ? { ownerPid: record.ownerPid }
      : {}),
    heartbeat: record.heartbeat,
  };
}

export function sanitizeBoundSessionLoss(value: unknown): BoundSessionLoss | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.code !== BOUND_SESSION_LOSS_CODE ||
    typeof record.sessionUuid !== "string" ||
    record.sessionUuid.trim().length === 0 ||
    typeof record.reason !== "string" ||
    record.reason.trim().length === 0
  ) {
    return undefined;
  }
  const release = sanitizeSessionReleaseSnapshot(record.release, record.sessionUuid);
  return {
    code: BOUND_SESSION_LOSS_CODE,
    sessionUuid: record.sessionUuid,
    reason: record.reason,
    ...(release ? { release } : {}),
  };
}

/**
 * Wire method for a relayed progress tick (issue #6205). Shared by the socket
 * server's push (`pushProgressNotification`) and the proxy's inbound dispatch
 * (`handleDaemonNotification`) so the two ends can never drift.
 */
export const PROGRESS_NOTIFICATION_METHOD = "notifications/progress";

export const RESOURCE_SUBSCRIBE_METHOD = "resources/subscribe";
export const RESOURCE_UNSUBSCRIBE_METHOD = "resources/unsubscribe";

/**
 * Server-pushed notification frame sent from daemon to a subscribed CLI client
 * over the control socket (issue #3223). Clients discriminate on `type`.
 * Only sent to sessions that opted in via `daemon/subscribe-notifications`, so
 * legacy/Kotlin/Swift clients never see an unexpected frame shape.
 */
export interface DaemonNotification {
  type: "daemon_notification";
  /** MCP notification method, e.g. "notifications/tools/list_changed". */
  method: string;
  /** Exact subscribed URI for notifications/resources/updated. */
  uri?: string;
  /**
   * Released session key for `notifications/session/released` frames (issue
   * #4610). Absent for list-changed frames. The proxy fences its remembered
   * binding only when this exactly equals its bound (base) session UUID.
   */
  sessionId?: string;
  /** Diagnostic release reason for `notifications/session/released`. */
  reason?: string;
  /** Authoritative terminal state captured before SessionManager removed it. */
  release?: SessionReleaseSnapshot;
  /**
   * Recording ids the release is finalizing (`notifications/session/released` only, additive).
   * The previous owner can still fetch each one by id after the release (#10958).
   */
  recordingIds?: string[];
  /**
   * The client-supplied progress token this tick belongs to, for
   * `notifications/progress` frames (issue #6205) — echoed verbatim from the
   * `tools/call` {@link DaemonRequest.progressToken} that requested it, never a
   * daemon-fabricated value. Absent for every other notification method.
   */
  progressToken?: string | number;
  /** Originating daemon request id for `notifications/progress` frames. */
  requestId?: string;
  /** Progress value for `notifications/progress` frames. */
  progress?: number;
  /** Optional total for `notifications/progress` frames. */
  total?: number;
  /** Optional human-readable status for `notifications/progress` frames. */
  message?: string;
}

/** Discriminates a daemon socket frame as a server-pushed notification. */
export function isDaemonNotification(frame: unknown): frame is DaemonNotification {
  return (
    typeof frame === "object" &&
    frame !== null &&
    (frame as { type?: unknown }).type === "daemon_notification" &&
    typeof (frame as { method?: unknown }).method === "string"
  );
}

/**
 * Known Unix-domain sockets exposed by the daemon.
 */
export type DaemonSocketName =
  | "control"
  | "appearance"
  | "device-snapshot"
  | "failures-push"
  | "failures-stream"
  | "observation-stream"
  | "performance-push"
  | "performance-stream"
  | "telemetry-push"
  | "test-recording"
  | "video-recording"
  | "video-stream"
  | "webrtc-stream";

/**
 * Every daemon socket except the control socket. Auxiliary sockets are declared
 * once in `daemonFiles.ts` as an exhaustive `Record` keyed by this type, so a
 * newly-added socket cannot be started without also being registered for
 * publication and cleanup (issue #4195).
 */
export type AuxiliaryDaemonSocketName = Exclude<DaemonSocketName, "control">;

export type DaemonSocketPaths = Record<DaemonSocketName, string>;

/**
 * Daemon status information
 */
export interface DaemonStatus {
  reportedPidFilePath?: string;
  reportedSocketPath?: string;
  reportedSockets?: Record<string, string>;
  /** Recovery never confuses an unverified socket owner with an absent daemon. */
  recovery?: {
    state: "repaired" | "replaced" | "deferred" | "unauthenticated" | "failed" | "joined";
    reason?: string;
    replacementOwner?: DaemonStatus;
  };
  /** Whether daemon is running */
  running: boolean;
  /** Process ID if running */
  pid?: number;
  /** HTTP port daemon is listening on */
  port?: number;
  /** Unix socket path */
  socketPath?: string;
  /** Unix socket paths exposed by the daemon, keyed by purpose */
  sockets?: DaemonSocketPaths;
  /** Absolute path to the SQLite file this daemon owns (issue #2795) */
  dbPath?: string;
  /** Timestamp when daemon was started */
  startedAt?: number;
  /**
   * OS process birth timestamp captured by the daemon itself. Unlike
   * {@link startedAt}, this is not delayed by daemon bootstrap and can fence
   * PID reuse against the process table.
   */
  processStartedAt?: number;
  /**
   * Stable OS-derived identity for this process generation (Linux, or a legacy
   * `darwin:` token from an older daemon). Optional so PID records written
   * before generation tokens remain readable. Read through
   * `recordedProcessGenerationToken`, never directly: Darwin publishes its
   * zone-free token under {@link processGenerationTokenUtc} instead.
   */
  processGenerationToken?: string;
  /**
   * Zone-free Darwin (`darwin-utc:`) generation token. A separate field so a
   * daemon build that predates it sees no token rather than a `darwin:`-vs-
   * `darwin-utc:` mismatch it would read as a recycled PID (see
   * `processGenerationFields.ts`).
   */
  processGenerationTokenUtc?: string;
  /** Daemon version */
  version?: string;
  /** Concrete CtrlProxy asset version resolved from AUTOMOBILE_VERSION at daemon start */
  assetVersion?: string;
  /** Absolute path to the daemon's entry script (build identity) */
  entryScript?: string;
  /** Content hash of the daemon's entry script (build identity) */
  buildId?: string;
  /** Whether this daemon generation is currently executing provisionDevice. */
  activeProvisioning?: boolean;
  /** Missing socket sessions use DAEMON_SESSION_NOT_FOUND_CODE; tool messages are not evidence. */
  structuredSessionNotFound?: boolean;
  /** Non-secret fingerprint of the acceptance discovery capability bound at startup. */
  acceptanceCapabilityFingerprint?: string | null;
  /**
   * Daemon's live effective debug state after the launch flag and persisted
   * `debug` feature flag have been applied. Unlike {@link options}.debug, this
   * value is not the frozen launch option used for restart reconciliation.
   */
  effectiveDebug?: boolean;
  /** Options used to start the daemon */
  options?: DaemonOptions;
}

/**
 * PID file contents
 */
/**
 * The last COMMITTED owner of a control socket, proven dead when a later
 * start's early-owner record overwrote its PID record (issue #10107). The early
 * record carries it so a start that dies before binding, or a `--daemon stop`,
 * does not erase the only proof that lets the next start's bind guard reclaim
 * the socket the dead owner left behind. Dropped by the next committed record.
 */
export interface SupersededSocketOwner {
  pid: number;
  /** Token compared with the live PID's, so a recycled PID still reads as dead. */
  processGenerationToken?: string;
  /** Zone-free Darwin token; see {@link PidFileData.processGenerationTokenUtc}. */
  processGenerationTokenUtc?: string;
}

export interface PidFileData {
  /** Process ID */
  pid: number;
  /**
   * Opaque session identity owned by this daemon process generation. Optional
   * for compatibility with PID files written before peer-liveness discovery.
   */
  daemonSessionId?: string;
  /** Unix socket path */
  socketPath: string;
  /** Unix socket paths exposed by the daemon, keyed by purpose */
  sockets?: DaemonSocketPaths;
  /** HTTP port */
  port: number;
  /**
   * Absolute path to the SQLite file this daemon owns. Lets a direct-mode
   * (`--no-proxy`) launch detect a same-file collision before opening a second
   * writer on it (issue #2795).
   */
  dbPath?: string;
  /** Timestamp when daemon was started */
  startedAt: number;
  /**
   * OS process birth timestamp captured by the daemon itself. Optional so
   * managers can continue reading PID files written by older daemon versions.
   */
  processStartedAt?: number;
  /**
   * Stable OS-derived identity for this process generation (Linux, or a legacy
   * `darwin:` token from an older daemon). Optional for backward compatibility
   * with PID files written before this field existed. Read through
   * `recordedProcessGenerationToken`, never directly.
   */
  processGenerationToken?: string;
  /**
   * Zone-free Darwin (`darwin-utc:`) generation token, published INSTEAD of
   * {@link processGenerationToken} on Darwin so older builds, which compare that
   * field strictly against their own time-zone-dependent token, see no token
   * and keep treating this daemon as live (see `processGenerationFields.ts`).
   */
  processGenerationTokenUtc?: string;
  /** Daemon version */
  version: string;
  /**
   * Launch-capture log inherited from DaemonManager, or null when this daemon
   * was started directly without one. Missing means an older record whose log
   * ownership cannot be determined safely.
   */
  launchLogPath?: string | null;
  /** Concrete CtrlProxy asset version resolved from AUTOMOBILE_VERSION at daemon start */
  assetVersion?: string;
  /** Absolute path to the daemon's entry script (build identity) */
  entryScript?: string;
  /** Content hash of the daemon's entry script (build identity) */
  buildId?: string;
  /** Options used to start the daemon */
  options?: DaemonOptions;
  /** Dead former committed socket owner carried by an uncommitted early record. */
  supersededOwner?: SupersededSocketOwner;
}

/**
 * Options for starting the daemon
 */
export interface DaemonOptions {
  /** HTTP port for internal MCP server */
  port?: number;
  /** Host for internal MCP server */
  host?: string;
  /**
   * Require the daemon's HTTP bind to succeed on exactly `port` (or the
   * default port) and fail loudly instead of silently falling back to a
   * higher port in the range via `findAvailablePort()`. Set by `DaemonManager.restart()`
   * so the child's own atomic `listen()` call — not a preflight probe that
   * releases its socket before the child actually binds — is the
   * authoritative guard against the #6260 TOCTOU split-brain.
   */
  strictPort?: boolean;
  /** Enable debug mode */
  debug?: boolean;
  /** Enable debug performance tracking */
  debugPerf?: boolean;
  /** Plan execution lock scope (session or global) */
  planExecutionLockScope?: "session" | "global";
  /** Default per-device automation runner readiness budget */
  runnerReadinessTimeoutMs?: number;
  /** Default video quality preset */
  videoQualityPreset?: string;
  /** Default video target bitrate in Kbps */
  videoTargetBitrateKbps?: number;
  /** Default video max throughput in Mbps */
  videoMaxThroughputMbps?: number;
  /** Default video FPS */
  videoFps?: number;
  /** Default video format */
  videoFormat?: string;
  /** Default video archive size limit in MB */
  videoMaxArchiveSizeMb?: number;
  /** Absolute host-local directory for tool output artifacts */
  toolOutputsDir?: string;
  /** Enable network mocking */
  networkMockable?: boolean;
  /** Expose tools that require the target app to embed the AutoMobile SDK */
  embeddedSdk?: boolean;
  /** Exact tool names enabled over their built-in defaults at daemon startup. */
  enabledTools?: string[];
  /** Exact tool names disabled under their built-in defaults at daemon startup. */
  disabledTools?: string[];
  /** Dismiss keyboard after text input (Android only) */
  dismissKeyboardAfterInput?: boolean;
  /** Markers that auto-promote inputText from `a11y` to `eventAll` (Android only) */
  eventAllMarkers?: string[];
  /** Preserve an explicit CLI marker override, including `--event-all-markers=` */
  eventAllMarkersCliOverride?: boolean;
  /** Disable UI performance mode */
  noUiPerfMode?: boolean;
  /** Enable memory performance audit */
  memPerfAudit?: boolean;
  /** Enable accessibility audit */
  accessibilityAudit?: boolean;
  /** Accessibility audit level */
  accessibilityLevel?: string;
  /** Accessibility audit failure mode */
  accessibilityFailureMode?: string;
  /** Accessibility audit minimum severity */
  accessibilityMinSeverity?: string;
  /** Accessibility audit use baseline */
  accessibilityUseBaseline?: boolean;
  /** Enable predictive UI */
  predictiveUi?: boolean;
  /** Enable raw element search */
  rawElementSearch?: boolean;
  /** Skip CtrlProxy download */
  skipCtrlProxyDownload?: boolean;
  /** Enable MCP recording feature flag */
  mcpRecording?: boolean;
  /** Disable navigation screenshots */
  noNavigationScreenshots?: boolean;
  /** Skip screenshots and back stack during waitFor polling to reduce ADB overhead */
  noWaitForPollingOverhead?: boolean;
  /** Disable FLAG_INCLUDE_NOT_IMPORTANT_VIEWS on the accessibility service */
  noA11yIncludeNotImportantViews?: boolean;
  /** Disable FLAG_REPORT_VIEW_IDS on the accessibility service */
  noA11yReportViewIds?: boolean;
  /** Disable FLAG_RETRIEVE_INTERACTIVE_WINDOWS on the accessibility service */
  noA11yRetrieveInteractiveWindows?: boolean;
  /** Disable the observe occlusion pass (occlusionState/occludedBy/occludedByViewId) */
  noOcclusion?: boolean;
  /**
   * Output reduction: opt back in to the flattened elements array on observe
   * results, dropped by default (issue #2756). Inverse of the retired
   * `observeResultDropElements`.
   */
  observeResultIncludeElements?: boolean;
  /** Output reduction: omit structuredContent from tool results (issue #2756) */
  toolResultsNoStructuredContent?: boolean;
  /** Output reduction: return only the observation diff after an action (issue #2756) */
  actionsDiffObserve?: boolean;
  /** Output reduction: skip the post-action observation entirely (issue #2756) */
  actionsNoObserve?: boolean;
  actionsCompactMetadata?: boolean;
}

/**
 * Session context for a connected CLI client
 */
export interface SessionContext {
  /** Unique session ID */
  sessionId: string;
  /** Timestamp when session was created */
  createdAt: number;
  /** Admission queue ordering this socket's requests (issue #6387) */
  requestQueue: SocketRequestAdmissionQueue;
  /**
   * Abort controllers for this socket's queued or in-flight requests, keyed by
   * request id, so a client cancel frame can abandon one (issue #6384).
   */
  requestCancellations: Map<string, AbortController>;
  /**
   * Set once a tool call on this socket carried `DAEMON_ONE_SHOT_CLI_PARAM` (#11096): the
   * connection is a one-shot `--cli` invocation, whose acquisitions are anonymous.
   */
  oneShotCli?: boolean;
}
