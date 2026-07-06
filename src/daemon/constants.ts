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

/**
 * Port range to try if default port is unavailable
 */
export const DAEMON_PORT_RANGE_START = 3000;
export const DAEMON_PORT_RANGE_END = 3010;

/**
 * Unix socket path for daemon communication
 * Per-user socket to avoid permission issues
 */
const socketPathOverride =
  process.env.AUTOMOBILE_DAEMON_SOCKET_PATH ??
  process.env.AUTO_MOBILE_DAEMON_SOCKET_PATH;
export const SOCKET_PATH =
  socketPathOverride
    ? resolvePathFromDaemonLaunchWorkingDirectory(socketPathOverride)
    : `/tmp/auto-mobile-daemon-${uid}.sock`;

/**
 * PID lock file path
 * Contains daemon process information
 */
const pidFilePathOverride =
  process.env.AUTOMOBILE_DAEMON_PID_FILE_PATH ??
  process.env.AUTO_MOBILE_DAEMON_PID_FILE_PATH;
export const PID_FILE_PATH =
  pidFilePathOverride
    ? resolvePathFromDaemonLaunchWorkingDirectory(pidFilePathOverride)
    : `/tmp/auto-mobile-daemon-${uid}.pid`;

/**
 * Lock file path for coordinating concurrent daemon start operations.
 * Prevents thundering herd when multiple proxy processes try to start
 * the daemon simultaneously.
 */
const lockFilePathOverride =
  process.env.AUTOMOBILE_DAEMON_LOCK_FILE_PATH ??
  process.env.AUTO_MOBILE_DAEMON_LOCK_FILE_PATH;
export const LOCK_FILE_PATH =
  lockFilePathOverride
    ? resolvePathFromDaemonLaunchWorkingDirectory(lockFilePathOverride)
    : `/tmp/auto-mobile-daemon-${uid}.lock`;

/**
 * Connection timeout in milliseconds
 * How long to wait for daemon to respond to a request.
 * Set to 120s to accommodate long-running operations like device cold boot (26-60s+).
 * Configurable via AUTOMOBILE_DAEMON_TIMEOUT_MS environment variable.
 */
const connectionTimeoutOverride =
  process.env.AUTOMOBILE_DAEMON_TIMEOUT_MS ??
  process.env.AUTO_MOBILE_DAEMON_TIMEOUT_MS;
const parsedConnectionTimeout = connectionTimeoutOverride
  ? Number.parseInt(connectionTimeoutOverride, 10)
  : NaN;
export const CONNECTION_TIMEOUT_MS =
  Number.isFinite(parsedConnectionTimeout) && parsedConnectionTimeout > 0
    ? parsedConnectionTimeout
    : 120000;

/**
 * Daemon startup timeout in milliseconds
 * How long to wait for daemon to become ready
 */
const startupTimeoutOverride =
  process.env.AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS ??
  process.env.AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS;
const parsedStartupTimeout = startupTimeoutOverride
  ? Number.parseInt(startupTimeoutOverride, 10)
  : NaN;
export const DAEMON_STARTUP_TIMEOUT_MS =
  Number.isFinite(parsedStartupTimeout) && parsedStartupTimeout > 0
    ? parsedStartupTimeout
    : 10000;

/**
 * Daemon shutdown timeout in milliseconds
 * How long to wait for graceful shutdown before SIGKILL
 */
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 5000;

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
 * Control-socket method a client sends to opt in to server-pushed
 * `DaemonNotification` frames (tools/resources list_changed forwarding,
 * issue #3223). Opt-in keeps the push invisible to Kotlin/Swift/legacy
 * clients that only understand request/response frames.
 */
export const DAEMON_SUBSCRIBE_NOTIFICATIONS_METHOD = "daemon/subscribe-notifications";

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
