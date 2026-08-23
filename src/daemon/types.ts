import type { DeviceControlTransportFailure } from "./deviceControlTransportFailure";
import type { SessionReleaseSnapshot } from "./sessionManager";

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
}

/**
 * Response sent from daemon to CLI client
 */
export interface DaemonResponse {
  /** Request ID this response corresponds to */
  id: string;
  /** Response type */
  type: "mcp_response";
  /** Whether the request was successful */
  success: boolean;
  /** Result data if successful */
  result?: any;
  /** Error message if unsuccessful */
  error?: string;
  /**
   * Safe, machine-readable details for a loopback device-control transport
   * failure. Optional so older Kotlin, Swift, and TypeScript clients keep using
   * the legacy string error without a wire-version break.
   */
  transportFailure?: DeviceControlTransportFailure;
  /**
   * Number of leading characters delivered by a failed Android
   * `input/typeText` append request. Present only when the append operation
   * reached the device before failing, or explicitly reports zero progress.
   */
  charsSent?: number;
}

/**
 * Server-pushed notification frame sent from daemon to a subscribed CLI client
 * over the control socket (issue #3223). Unlike {@link DaemonResponse} it has no
 * `id` — it does not correlate to a request. Clients discriminate on `type`.
 * Only sent to sessions that opted in via `daemon/subscribe-notifications`, so
 * legacy/Kotlin/Swift clients never see an unexpected frame shape.
 */
export interface DaemonNotification {
  type: "daemon_notification";
  /** MCP notification method, e.g. "notifications/tools/list_changed". */
  method: string;
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
  /** Daemon version */
  version?: string;
  /** Concrete CtrlProxy asset version resolved from AUTOMOBILE_VERSION at daemon start */
  assetVersion?: string;
  /** Absolute path to the daemon's entry script (build identity) */
  entryScript?: string;
  /** Content hash of the daemon's entry script (build identity) */
  buildId?: string;
  /** Options used to start the daemon */
  options?: DaemonOptions;
}

/**
 * PID file contents
 */
export interface PidFileData {
  /** Process ID */
  pid: number;
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
  /** Daemon version */
  version: string;
  /** Concrete CtrlProxy asset version resolved from AUTOMOBILE_VERSION at daemon start */
  assetVersion?: string;
  /** Absolute path to the daemon's entry script (build identity) */
  entryScript?: string;
  /** Content hash of the daemon's entry script (build identity) */
  buildId?: string;
  /** Options used to start the daemon */
  options?: DaemonOptions;
}

/**
 * Options for starting the daemon
 */
export interface DaemonOptions {
  /** HTTP port for internal MCP server */
  port?: number;
  /** Host for internal MCP server */
  host?: string;
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
}

/**
 * Session context for a connected CLI client
 */
export interface SessionContext {
  /** Unique session ID */
  sessionId: string;
  /** Timestamp when session was created */
  createdAt: number;
  /** Queue of pending requests for this session */
  requestQueue: Array<() => Promise<any>>;
  /** Whether a request is currently being processed */
  processing: boolean;
}
