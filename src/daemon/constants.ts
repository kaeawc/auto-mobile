import { platform } from "node:os";
import { getMcpServerVersion } from "../utils/mcpVersion";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../utils/workingDirectory";

/**
 * Get the user ID for the current process
 * On Unix systems, this is the actual UID
 * On Windows, we use a fallback based on username
 */
function getUserId(): string {
  if (platform() === "win32") {
    // Windows doesn't have UIDs, use username as fallback
    return process.env.USERNAME || "default";
  }
  // Unix systems: use actual UID
  return process.getuid?.()?.toString() || "default";
}

const uid = getUserId();

/**
 * Default port for the daemon's internal HTTP server
 */
export const DEFAULT_DAEMON_PORT = 3000;

/** Remaining outer request budget forwarded to the in-daemon MCP handler. */
export const INTERNAL_MCP_REQUEST_TIMEOUT_PARAM = "__mcpRequestTimeoutMs";

/**
 * This execution's own start time, on the same `defaultTimer` clock used
 * throughout `src/server/` and `src/features/`. Combined with
 * {@link INTERNAL_MCP_REQUEST_TIMEOUT_PARAM} (`startTime + remainingMs`),
 * gives a tool handler the ABSOLUTE wall-clock deadline of the current MCP
 * request -- exported here (rather than kept local to `server/index.ts`,
 * where it originates) so a tool handler outside `server/` (e.g.
 * `setUIStateHandler` in `server/formTools.ts`) can read it back without an
 * import cycle through `server/index.ts` (issue #6222 P1).
 */
export const INTERNAL_EXECUTION_START_TIME_PARAM = "__executionStartTime";

/**
 * Key into the in-process {@link module:daemon/liveDeadlineRegistry} for the
 * LIVE (possibly progress-extended) `ProgressExtendableDeadline` backing the
 * current daemon-forwarded request, when one exists (issue #6222 P1 reopen).
 *
 * {@link INTERNAL_MCP_REQUEST_TIMEOUT_PARAM} is a snapshot taken once, before
 * the request is forwarded -- it never reflects a later extension made by
 * `UnixSocketServer.handleIdeRequest`'s `onprogress` handler as the SAME call
 * keeps emitting progress. The daemon and the MCP HTTP server it forwards to
 * run in one Node process (`Daemon` in `daemon.ts` owns both), so rather than
 * try to serialize a live object over the loopback HTTP transport, the daemon
 * registers its `ProgressExtendableDeadline` under a fresh key in that
 * shared, in-process registry and forwards only this key. A handler that
 * recognizes it (currently only `setUIStateHandler`) can then read the
 * deadline's CURRENT value at each of its own admission checks instead of a
 * frozen number. Absent when the request carries no progress token (nothing
 * to extend) or is not daemon-forwarded at all.
 */
export const INTERNAL_LIVE_DEADLINE_KEY_PARAM = "__mcpLiveDeadlineKey";

/**
 * Port range to try if default port is unavailable
 */
export const DAEMON_PORT_RANGE_START = 3000;
export const DAEMON_PORT_RANGE_END = 3010;

/**
 * Unix socket path for daemon communication
 * Per-user socket to avoid permission issues
 */
/**
 * The built-in socket path with no env override applied — i.e. what {@link SOCKET_PATH}
 * would be on a completely unconfigured host. Unlike `SOCKET_PATH`, this is NOT affected
 * by `AUTOMOBILE_DAEMON_SOCKET_PATH`/`AUTO_MOBILE_DAEMON_SOCKET_PATH`, so it is the correct
 * value to compare an effective socket path against when detecting whether a manager is
 * using an isolated socket namespace (issue #6140): comparing against `SOCKET_PATH` itself
 * is always a no-op once the env var is what initialized `SOCKET_PATH` in the first place.
 */
export const DEFAULT_SOCKET_PATH = `/tmp/auto-mobile-daemon-${uid}.sock`;

const socketPathOverride =
  process.env.AUTOMOBILE_DAEMON_SOCKET_PATH ?? process.env.AUTO_MOBILE_DAEMON_SOCKET_PATH;
export const SOCKET_PATH = socketPathOverride
  ? resolvePathFromDaemonLaunchWorkingDirectory(socketPathOverride)
  : DEFAULT_SOCKET_PATH;

/**
 * PID lock file path
 * Contains daemon process information
 */
/**
 * The built-in PID file path with no env override applied — see {@link DEFAULT_SOCKET_PATH}
 * for why this (not `PID_FILE_PATH`) is the correct isolated-namespace comparison target.
 */
export const DEFAULT_PID_FILE_PATH = `/tmp/auto-mobile-daemon-${uid}.pid`;

const pidFilePathOverride =
  process.env.AUTOMOBILE_DAEMON_PID_FILE_PATH ?? process.env.AUTO_MOBILE_DAEMON_PID_FILE_PATH;
export const PID_FILE_PATH = pidFilePathOverride
  ? resolvePathFromDaemonLaunchWorkingDirectory(pidFilePathOverride)
  : DEFAULT_PID_FILE_PATH;

/**
 * Lock file path for coordinating concurrent daemon start operations.
 * Prevents thundering herd when multiple proxy processes try to start
 * the daemon simultaneously.
 */
const lockFilePathOverride =
  process.env.AUTOMOBILE_DAEMON_LOCK_FILE_PATH ?? process.env.AUTO_MOBILE_DAEMON_LOCK_FILE_PATH;
export const LOCK_FILE_PATH = lockFilePathOverride
  ? resolvePathFromDaemonLaunchWorkingDirectory(lockFilePathOverride)
  : `/tmp/auto-mobile-daemon-${uid}.lock`;

/**
 * Connection timeout in milliseconds
 * How long to wait for daemon to respond to a request.
 * Set to 120s to accommodate long-running operations like device cold boot (26-60s+).
 * Configurable via AUTOMOBILE_DAEMON_TIMEOUT_MS environment variable.
 */
const connectionTimeoutOverride =
  process.env.AUTOMOBILE_DAEMON_TIMEOUT_MS ?? process.env.AUTO_MOBILE_DAEMON_TIMEOUT_MS;
const parsedConnectionTimeout = connectionTimeoutOverride
  ? Number.parseInt(connectionTimeoutOverride, 10)
  : NaN;
export const CONNECTION_TIMEOUT_MS =
  Number.isFinite(parsedConnectionTimeout) && parsedConnectionTimeout > 0
    ? parsedConnectionTimeout
    : 120000;

/**
 * Daemon startup timeout in milliseconds
 * How long to wait for daemon to become ready. Cold startup serially discovers
 * devices and initializes iOS services, so the default allows normal
 * multi-simulator bring-up while remaining bounded.
 */
const startupTimeoutOverride =
  process.env.AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS ??
  process.env.AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS;
const parsedStartupTimeout = startupTimeoutOverride
  ? Number.parseInt(startupTimeoutOverride, 10)
  : NaN;
// Node and Bun clamp timer delays above this value to 1ms.
const MAX_DAEMON_STARTUP_TIMEOUT_MS = 2_147_483_647;
export const DAEMON_STARTUP_TIMEOUT_MS =
  Number.isFinite(parsedStartupTimeout) && parsedStartupTimeout > 0
    ? Math.min(parsedStartupTimeout, MAX_DAEMON_STARTUP_TIMEOUT_MS)
    : 30000;

/**
 * Reachability budget for an already-live daemon during start (milliseconds).
 *
 * When a start request finds a live daemon process without a usable PID record,
 * it waits for that daemon to become reachable before deciding what to do. This
 * wait is nested INSIDE a client's `tools/list` request, and clients time that
 * request out at ~30s (`DAEMON_STARTUP_TIMEOUT_MS`). If the wait itself consumed
 * the full startup budget, the actionable "refusing to terminate a live daemon"
 * error would be produced only as the client's own deadline expires — so the one
 * useful diagnostic in the flow never reaches the client and AutoMobile appears
 * connected with zero tools (issue #5871).
 *
 * Budgeting this wait well under the client request timeout guarantees the
 * error is delivered rather than raced by the timeout it lives inside. This is
 * only the reachability wait for an EXISTING daemon; cold-start bring-up still
 * uses the full `DAEMON_STARTUP_TIMEOUT_MS`.
 *
 * The value is capped at two-thirds of the startup timeout, never at the full
 * timeout: a budget EQUAL to `DAEMON_STARTUP_TIMEOUT_MS` (which the client uses
 * as its request deadline) would produce the actionable error at the exact
 * deadline it must beat, re-opening the zero-tools race for an override at or
 * above the ceiling. Capping below the timeout reserves headroom so the error
 * is always deliverable, and scaling with the timeout keeps that headroom
 * meaningful when the startup budget is itself lowered.
 */
const existingDaemonReachabilityOverride =
  process.env.AUTOMOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS ??
  process.env.AUTO_MOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS;
const parsedExistingDaemonReachability = existingDaemonReachabilityOverride
  ? Number.parseInt(existingDaemonReachabilityOverride, 10)
  : NaN;
const maxExistingDaemonReachabilityMs = Math.max(
  1,
  Math.floor((DAEMON_STARTUP_TIMEOUT_MS * 2) / 3),
);
export const DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS = Math.min(
  Number.isFinite(parsedExistingDaemonReachability) && parsedExistingDaemonReachability > 0
    ? parsedExistingDaemonReachability
    : 10000,
  maxExistingDaemonReachabilityMs,
);

/**
 * Daemon shutdown timeout in milliseconds
 * How long to wait for graceful shutdown before SIGKILL
 */
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 10000;

/**
 * Minimum age (ms since startedAt) before the proxy will restart a daemon on
 * version mismatch. Prevents thrash when concurrent agents on different versions
 * each try to "fix" the daemon to their own version.
 */
export const DAEMON_VERSION_RESTART_COOLDOWN_MS = 10000;

/**
 * Readiness probe retry budget.
 *
 * A single failed socket-connect probe is NOT authoritative: a live daemon under
 * load can transiently refuse a connection (listen backlog overflow, slow first
 * accept right after a (re)start). The readiness loop must retry a few times
 * before treating the socket as dead — otherwise it unlinks a healthy daemon's
 * socket and every subsequent client connect throws "Daemon socket not found",
 * surfacing to the user as "devices not found after start/restart".
 */
export const READINESS_PROBE_MAX_ATTEMPTS = 3;
export const READINESS_PROBE_BACKOFF_MS = 150;

/**
 * MCP streamable endpoint path
 */
export const MCP_STREAMABLE_PATH = "/auto-mobile/streamable";

/**
 * Internal loopback header used to restore a daemon socket's tool-selection
 * profile when its Streamable HTTP MCP transport is recreated.
 */
export const DAEMON_SESSION_TOOL_BINDING_HEADER = "x-auto-mobile-session-uuid";

/** Loopback-only header for a persisted connection tool-selection profile. */
export const DAEMON_TOOL_SELECTION_PROFILE_HEADER = "x-auto-mobile-tool-selection-profile-uuid";

/** Socket RPC field consumed before tool arguments reach the MCP server. */
export const DAEMON_TOOL_SELECTION_PROFILE_PARAM = "__autoMobileToolSelectionProfileUuid";

/**
 * Socket RPC field identifying a session UUID injected from a connection-bound
 * route rather than explicitly selected by the caller.
 */
export const DAEMON_BOUND_SESSION_PARAM = "__autoMobileBoundSessionUuid";

/** Socket RPC field identifying a released session used only for inactive resource reads. */
export const DAEMON_RELEASED_SESSION_PARAM = "__autoMobileReleasedSessionUuid";

/**
 * Transport-provenance flag the daemon client sets inside a tool call's
 * `arguments` when — and only when — it transformed the payload on the wire
 * (#5863): either sentinel-encoded a non-finite argument, or escaped a real object
 * that collides with the sentinel shape. Both must be reversed by the receiver, so
 * the MCP CallTool handler revives only requests carrying this flag; direct
 * in-memory / stdio clients (whose requests were never encoded) skip the revival
 * walk entirely. It is stripped before the tool runs (see `stripInternalToolParams`).
 */
export const DAEMON_NON_FINITE_ENCODED_PARAM = "__autoMobileNonFiniteEncoded";

/** Loopback-only header for a released session's inactive resource-read capability. */
export const DAEMON_RELEASED_SESSION_HEADER = "x-auto-mobile-released-session-uuid";

/**
 * How long the proxy will keep replaying a remembered session binding on
 * sessionless calls before treating it as retired (issue #4610). It mirrors the
 * daemon's session idle timeout (`SessionManager.SESSION_TIMEOUT_MS`, 30 min):
 * once this window elapses with no forwarded call (explicit or implicit)
 * refreshing the binding, the daemon session has certainly idle/heartbeat-expired, and
 * replaying its UUID would silently recreate the released session and reacquire
 * a device without the caller asking for it.
 */
export const DAEMON_BOUND_SESSION_REPLAY_TTL_MS = 30 * 60 * 1000;

/**
 * Control-socket method a client sends to opt in to server-pushed
 * `DaemonNotification` frames (tools/resources list_changed forwarding,
 * issue #3223). Opt-in keeps the push invisible to Kotlin/Swift/legacy
 * clients that only understand request/response frames.
 */
export const DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD = "daemon/subscribe-notifications";

/**
 * Bound-session keepalive method. Must be answered immediately, never queued
 * behind an in-flight `tools/call` on the same socket: the MCP proxy's keeper
 * sends this over the same `DaemonClient` socket used for tool forwarding, so
 * head-of-line blocking behind a long acquisition call (e.g. `startDevice` for
 * a second device) can starve the heartbeat past the session's
 * heartbeat-timeout and get it reaped (issue #6135).
 */
export const DAEMON_HEARTBEAT_METHOD = "daemon/heartbeat";

/**
 * Control-socket method returning the current `deviceId (serial/UDID) ↔
 * deviceSessionUuid` map from the daemon's `DeviceSessionRegistry`. Lets a
 * stream consumer resolve a serial to its stable connection-epoch identity
 * (device-session-UUID routing epic #5256).
 */
export const DAEMON_LIST_DEVICE_SESSIONS_METHOD = "daemon/listDeviceSessions";

/**
 * Whether the daemon enforces the inbound version/build-identity handshake
 * (#2744). Enabled by default; set `AUTOMOBILE_DAEMON_DISABLE_HANDSHAKE=1`
 * (or `AUTO_MOBILE_DAEMON_DISABLE_HANDSHAKE=1`) as an escape hatch if a
 * mismatched client must be allowed through during an incident. Clients that
 * declare no handshake fields are always allowed regardless of this flag.
 */
const handshakeDisableOverride = (
  process.env.AUTOMOBILE_DAEMON_DISABLE_HANDSHAKE ??
  process.env.AUTO_MOBILE_DAEMON_DISABLE_HANDSHAKE ??
  ""
)
  .trim()
  .toLowerCase();
export const DAEMON_HANDSHAKE_ENABLED = !(
  handshakeDisableOverride === "1" ||
  handshakeDisableOverride === "true" ||
  handshakeDisableOverride === "yes"
);

/**
 * Package version (read from package.json)
 * Used for version compatibility checks and PID file metadata
 */
export const DAEMON_VERSION = getMcpServerVersion();
