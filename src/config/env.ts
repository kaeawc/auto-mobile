/**
 * Typed registry of environment variables (#11848).
 *
 * Every variable AutoMobile reads should be declared here once, with its legacy
 * spelling, kind, default and a one-line description, and read through
 * {@link readEnvTrimmed}. Readers take an injected `env` so tests never mutate
 * `process.env`. Unmigrated raw reads are listed in
 * `test/lint/env-registry-baseline.txt`, which may only shrink.
 */

export type EnvVarKind = "path" | "string" | "bool" | "int" | "number" | "enum" | "list";

export interface EnvVarSpec {
  /** Canonical variable name. */
  readonly name: string;
  /** Deprecated `AUTO_MOBILE_` spelling, consulted only when `name` is unset. */
  readonly legacyName?: string;
  readonly kind: EnvVarKind;
  /** Human-readable default (documentation only; resolution stays at the call site). */
  readonly default: string;
  readonly doc: string;
  /** `int` / `number`: smallest accepted value (inclusive unless `minExclusive`). */
  readonly min?: number;
  readonly minExclusive?: boolean;
  /** `int`: value used when the variable is unset or unusable. */
  readonly fallback?: number;
  /** `enum`: accepted lowercase values. */
  readonly values?: readonly string[];
}

export const ENV = {
  DATA_DIR: {
    name: "AUTOMOBILE_DATA_DIR",
    legacyName: "AUTO_MOBILE_DATA_DIR",
    kind: "path",
    default: "~/.auto-mobile",
    doc: "Base directory for AutoMobile state; relative to the daemon launch directory.",
  },
  LOG_DIR: {
    name: "AUTOMOBILE_LOG_DIR",
    legacyName: "AUTO_MOBILE_LOG_DIR",
    kind: "path",
    default: "$AUTOMOBILE_DATA_DIR/logs",
    doc: "Daemon and client log directory; relative to the daemon launch directory.",
  },
  COORDINATION_DIR: {
    name: "AUTOMOBILE_COORDINATION_DIR",
    legacyName: "AUTO_MOBILE_COORDINATION_DIR",
    kind: "path",
    default: "~/.auto-mobile",
    doc: "Absolute root of cross-process coordination state shared by cooperating agents.",
  },
  SESSION_BROKER_CONFIG: {
    name: "AUTOMOBILE_SESSION_BROKER_CONFIG",
    kind: "path",
    default: "unset (broker disabled)",
    doc: "Operator session-broker host configuration file; never a session requester input.",
  },
  SESSION_CONFIG: {
    name: "AUTOMOBILE_SESSION_CONFIG",
    kind: "path",
    default: "unset",
    doc: "Session configuration file read by the CLI, equivalent to --session-config.",
  },
  ADB_SERVER_COORDINATION_DIR: {
    name: "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR",
    legacyName: "AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR",
    kind: "path",
    default: "~/.auto-mobile/adb-servers",
    doc: "Absolute root of per-ADB-server claims shared by every daemon on one ADB server.",
  },
  PRIVATE_DAEMON_ORPHAN_IDLE_MS: {
    name: "AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS",
    kind: "number",
    default: "900000",
    min: 0,
    doc: "Idle timeout in ms for an orphaned private daemon; 0 disables the watchdog.",
  },
  OBSERVE_PERF_SNAPSHOT: {
    name: "AUTOMOBILE_OBSERVE_PERF_SNAPSHOT",
    legacyName: "AUTO_MOBILE_OBSERVE_PERF_SNAPSHOT",
    kind: "bool",
    default: "off",
    doc: "Attach a windowed performance snapshot to observe results.",
  },
  OBSERVE_PERF_WINDOW_MS: {
    name: "AUTOMOBILE_OBSERVE_PERF_WINDOW_MS",
    legacyName: "AUTO_MOBILE_OBSERVE_PERF_WINDOW_MS",
    kind: "number",
    default: "5000",
    min: 0,
    minExclusive: true,
    doc: "Rolling window for the performance snapshot; fractions are rounded.",
  },
  VIDEO_RETENTION_DAYS: {
    name: "AUTOMOBILE_VIDEO_RETENTION_DAYS",
    legacyName: "AUTO_MOBILE_VIDEO_RETENTION_DAYS",
    kind: "number",
    default: "see docs",
    min: 0,
    doc: "Age in days after which recordings are deleted; 0 disables the sweep.",
  },
  VIDEO_RETENTION_SWEEP_MINUTES: {
    name: "AUTOMOBILE_VIDEO_RETENTION_SWEEP_MINUTES",
    legacyName: "AUTO_MOBILE_VIDEO_RETENTION_SWEEP_MINUTES",
    kind: "number",
    default: "see docs",
    min: 0,
    minExclusive: true,
    doc: "How often the recording retention sweep runs, in minutes.",
  },
  VIDEO_INPROGRESS_CHECK_SECONDS: {
    name: "AUTOMOBILE_VIDEO_INPROGRESS_CHECK_SECONDS",
    legacyName: "AUTO_MOBILE_VIDEO_INPROGRESS_CHECK_SECONDS",
    kind: "number",
    default: "see docs",
    min: 0,
    minExclusive: true,
    doc: "How often an in-progress recording's size is checked, in seconds.",
  },
  PORT_RANGE_START: {
    name: "AUTOMOBILE_PORT_RANGE_START",
    legacyName: "AUTO_MOBILE_PORT_RANGE_START",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "First CtrlProxy host port.",
  },
  PORT_RANGE_END: {
    name: "AUTOMOBILE_PORT_RANGE_END",
    legacyName: "AUTO_MOBILE_PORT_RANGE_END",
    kind: "string",
    default: "unset",
    doc: "Inclusive last CtrlProxy host port.",
  },
  PORT_RANGE_SIZE: {
    name: "AUTOMOBILE_PORT_RANGE_SIZE",
    legacyName: "AUTO_MOBILE_PORT_RANGE_SIZE",
    kind: "string",
    default: "unset",
    doc: "Number of CtrlProxy host ports.",
  },
  DOCTOR_TIMEOUT_MS: {
    name: "AUTOMOBILE_DOCTOR_TIMEOUT_MS",
    kind: "int",
    default: "5000",
    fallback: 5000,
    min: 1,
    doc: "Timeout in ms for each external doctor probe.",
  },
  WORK_PROFILE_POLL_INTERVAL_MS: {
    name: "AUTOMOBILE_WORK_PROFILE_POLL_INTERVAL_MS",
    kind: "int",
    default: "5000",
    min: 1,
    doc: "Work-profile polling interval in ms.",
  },
  DISABLE_PERF_AUDIT: {
    name: "AUTOMOBILE_DISABLE_PERF_AUDIT",
    kind: "bool",
    default: "off",
    doc: "Disable the UI performance audit.",
  },
  TOUCH_LATENCY_SAMPLING: {
    name: "AUTOMOBILE_TOUCH_LATENCY_SAMPLING",
    kind: "bool",
    default: "off",
    doc: "Opt into synthetic tap latency sampling.",
  },
  MAX_OBSERVATION_AGE_MS: {
    name: "AUTOMOBILE_MAX_OBSERVATION_AGE_MS",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "Hierarchy freshness budget in ms.",
  },
  IOS_SCREEN_CAPTURE_HELPER: {
    name: "AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER",
    legacyName: "AUTO_MOBILE_IOS_SCREEN_CAPTURE_HELPER",
    kind: "path",
    default: "unset",
    doc: "Absolute path to a locally built screen-capture-helper.",
  },
  ACTION_OBSERVATION_SKIP_SCREENSHOT: {
    name: "AUTOMOBILE_ACTION_OBSERVATION_SKIP_SCREENSHOT",
    kind: "string",
    default: "skip",
    doc: "Skip automatic screenshots after actions unless set to false or 0.",
  },
  OBSERVE_WAIT_FOR_SKIP_SCREENSHOT: {
    name: "AUTOMOBILE_OBSERVE_WAIT_FOR_SKIP_SCREENSHOT",
    kind: "string",
    default: "skip",
    doc: "Skip automatic screenshots for waitFor observations unless set to false or 0.",
  },
  OBSERVE_SETTLED_SCREENSHOT: {
    name: "AUTOMOBILE_OBSERVE_SETTLED_SCREENSHOT",
    kind: "string",
    default: "unset",
    doc: "Select settled screenshot mode with true or 1.",
  },
  EMULATOR_AUDIO: {
    name: "AUTOMOBILE_EMULATOR_AUDIO",
    kind: "string",
    default: "audio on",
    doc: "Exact false adds -no-audio to emulator launches; other values keep audio.",
  },
  DB_PATH: {
    name: "AUTOMOBILE_DB_PATH",
    legacyName: "AUTO_MOBILE_DB_PATH",
    kind: "path",
    default: "~/.auto-mobile/auto-mobile.db",
    doc: "Exact SQLite database file; takes precedence over the DB directory. `:memory:` is test-only.",
  },
  DB_DIR: {
    name: "AUTOMOBILE_DB_DIR",
    legacyName: "AUTO_MOBILE_DB_DIR",
    kind: "path",
    default: "~/.auto-mobile",
    doc: "Directory containing auto-mobile.db.",
  },
  MIGRATIONS_DIR: {
    name: "AUTOMOBILE_MIGRATIONS_DIR",
    legacyName: "AUTO_MOBILE_MIGRATIONS_DIR",
    kind: "path",
    default: "bundled static migrations",
    doc: "Directory of migration modules loaded instead of the bundled static migrations.",
  },
  MIGRATION_RECOVERY: {
    name: "AUTOMOBILE_MIGRATION_RECOVERY",
    legacyName: "AUTO_MOBILE_MIGRATION_RECOVERY",
    kind: "string",
    default: "safe recovery on; destructive reset off",
    doc: "Safe recovery is on unless 0/false/no/off; only exact 1 permits the destructive reset.",
  },
  MIGRATION_LOCK_TIMEOUT_MS: {
    name: "AUTOMOBILE_MIGRATION_LOCK_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_MIGRATION_LOCK_TIMEOUT_MS",
    kind: "int",
    default: "60000",
    min: 1,
    doc: "File-scoped migration lock wait; positive base-10 integer milliseconds.",
  },
  ALLOW_IN_MEMORY_DB: {
    name: "AUTOMOBILE_ALLOW_IN_MEMORY_DB",
    kind: "bool",
    default: "unset",
    doc: "Test-only opt-in (1/true/yes) permitting the `:memory:` database path.",
  },
  NAV_RETENTION_SCREENSHOT_TTL_MS: {
    name: "AUTOMOBILE_NAV_RETENTION_SCREENSHOT_TTL_MS",
    kind: "int",
    default: "604800000",
    min: 1,
    doc: "Screenshot retention TTL; positive safe integer milliseconds.",
  },
  NAV_RETENTION_STRUCTURE_TTL_MS: {
    name: "AUTOMOBILE_NAV_RETENTION_STRUCTURE_TTL_MS",
    kind: "int",
    default: "7776000000",
    min: 1,
    doc: "Structure retention TTL; positive safe integer milliseconds.",
  },
  NAV_RETENTION_PER_APP_MAX_OBSERVATIONS: {
    name: "AUTOMOBILE_NAV_RETENTION_PER_APP_MAX_OBSERVATIONS",
    kind: "int",
    default: "50000",
    min: 1,
    doc: "Per-app observation cap; positive safe integer.",
  },
  NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS: {
    name: "AUTOMOBILE_NAV_RETENTION_GLOBAL_MAX_OBSERVATIONS",
    kind: "int",
    default: "500000",
    min: 1,
    doc: "Global observation cap; positive safe integer.",
  },
  NAV_RETENTION_EVICTION_CHUNK_SIZE: {
    name: "AUTOMOBILE_NAV_RETENTION_EVICTION_CHUNK_SIZE",
    kind: "int",
    default: "5000",
    min: 1,
    doc: "Rows per eviction batch; positive safe integer clamped to 10000.",
  },
  NAV_RETENTION_INTERVAL_MS: {
    name: "AUTOMOBILE_NAV_RETENTION_INTERVAL_MS",
    kind: "int",
    default: "21600000",
    min: 1,
    doc: "Retention sweep cadence; positive safe integer milliseconds at most 2147483647.",
  },
  DAEMON_SOCKET_PATH: {
    name: "AUTOMOBILE_DAEMON_SOCKET_PATH",
    legacyName: "AUTO_MOBILE_DAEMON_SOCKET_PATH",
    kind: "path",
    default: "per-uid path under /tmp",
    doc: "Control-socket path override for a private daemon; relative to the daemon launch directory.",
  },
  DAEMON_PID_FILE_PATH: {
    name: "AUTOMOBILE_DAEMON_PID_FILE_PATH",
    legacyName: "AUTO_MOBILE_DAEMON_PID_FILE_PATH",
    kind: "path",
    default: "per-uid path under /tmp",
    doc: "Daemon PID file path override; relative to the daemon launch directory.",
  },
  DAEMON_LOCK_FILE_PATH: {
    name: "AUTOMOBILE_DAEMON_LOCK_FILE_PATH",
    legacyName: "AUTO_MOBILE_DAEMON_LOCK_FILE_PATH",
    kind: "path",
    default: "per-uid path under /tmp",
    doc: "Daemon lock file path override; relative to the daemon launch directory.",
  },
  AUX_SOCKET_DIR: {
    name: "AUTOMOBILE_AUX_SOCKET_DIR",
    kind: "path",
    default: "per-uid directory under /tmp",
    doc: "Auxiliary daemon socket directory; also isolates a private daemon namespace.",
  },
  WEBRTC_STREAM_SOCKET_PATH: {
    name: "AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH",
    legacyName: "AUTO_MOBILE_WEBRTC_STREAM_SOCKET_PATH",
    kind: "path",
    default: "webrtc-stream.sock in the aux socket directory",
    doc: "WebRTC stream socket path override.",
  },
  DAEMON_LAUNCHER_PID: {
    name: "AUTOMOBILE_DAEMON_LAUNCHER_PID",
    kind: "string",
    default: "unset",
    doc: "Launcher process id a private daemon watches for orphaning.",
  },
  HARNESS_PRIVATE_DAEMON: {
    name: "AUTOMOBILE_HARNESS_PRIVATE_DAEMON",
    kind: "string",
    default: "unset",
    doc: "Marker identifying a harness-launched private daemon.",
  },
  ALLOW_SHARED_DAEMON_NAMESPACE: {
    name: "AUTOMOBILE_ALLOW_SHARED_DAEMON_NAMESPACE",
    kind: "string",
    default: "unset",
    doc: "Exact 1 opts out of the shared-namespace guard.",
  },
  DAEMON_STREAM_AUTH: {
    name: "AUTOMOBILE_DAEMON_STREAM_AUTH",
    kind: "string",
    default: "see docs",
    doc: "Stream-socket authentication enforcement switch.",
  },
  DAEMON_DISABLE_HANDSHAKE: {
    name: "AUTOMOBILE_DAEMON_DISABLE_HANDSHAKE",
    legacyName: "AUTO_MOBILE_DAEMON_DISABLE_HANDSHAKE",
    kind: "string",
    default: "handshake enforced",
    doc: "Disables the inbound version handshake when 1, true or yes.",
  },
  DAEMON_TIMEOUT_MS: {
    name: "AUTOMOBILE_DAEMON_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_DAEMON_TIMEOUT_MS",
    kind: "int",
    default: "120000",
    min: 1,
    doc: "Daemon request timeout; positive base-10 integer milliseconds.",
  },
  DAEMON_STARTUP_TIMEOUT_MS: {
    name: "AUTOMOBILE_DAEMON_STARTUP_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_DAEMON_STARTUP_TIMEOUT_MS",
    kind: "int",
    default: "30000",
    min: 1,
    doc: "Daemon startup timeout; positive base-10 integer milliseconds.",
  },
  DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS: {
    name: "AUTOMOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_DAEMON_EXISTING_REACHABILITY_TIMEOUT_MS",
    kind: "int",
    default: "10000",
    min: 1,
    doc: "Reachability wait for an already-live daemon; positive base-10 integer milliseconds.",
  },
  CLI_SESSION_IDLE_TIMEOUT_MS: {
    name: "AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_CLI_SESSION_IDLE_TIMEOUT_MS",
    kind: "int",
    default: "120000",
    min: 1,
    doc: "CLI session idle window; positive base-10 integer milliseconds, never below the default.",
  },
  SESSION_HEARTBEAT_CHECK_INTERVAL_MS: {
    name: "AUTOMOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
    legacyName: "AUTO_MOBILE_SESSION_HEARTBEAT_CHECK_INTERVAL_MS",
    kind: "int",
    default: "2000",
    min: 1,
    doc: "Session heartbeat scan cadence; positive base-10 integer milliseconds.",
  },
  SESSION_HEARTBEAT_INITIAL_GRACE_MS: {
    name: "AUTOMOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
    legacyName: "AUTO_MOBILE_SESSION_HEARTBEAT_INITIAL_GRACE_MS",
    kind: "int",
    default: "20000",
    min: 1,
    doc: "Initial grace before heartbeat reaping; positive base-10 integer milliseconds.",
  },
  SESSION_HEARTBEAT_TIMEOUT_MS: {
    name: "AUTOMOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_SESSION_HEARTBEAT_TIMEOUT_MS",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "Session heartbeat timeout; positive base-10 integer milliseconds.",
  },
  SESSION_IDLE_TIMEOUT_MS: {
    name: "AUTOMOBILE_SESSION_IDLE_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_SESSION_IDLE_TIMEOUT_MS",
    kind: "int",
    default: "120000",
    min: 1,
    doc: "Session idle window; positive base-10 integer milliseconds.",
  },
  SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS: {
    name: "AUTOMOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
    legacyName: "AUTO_MOBILE_SESSION_PRE_FIRST_HEARTBEAT_GRACE_MS",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "Grace for a session that never heartbeats; positive base-10 integer milliseconds.",
  },
  OBSERVE_MCP_TIMEOUT_MS: {
    name: "AUTOMOBILE_OBSERVE_MCP_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_OBSERVE_MCP_TIMEOUT_MS",
    kind: "int",
    default: "90000",
    min: 1,
    doc: "Floor for the observe MCP request timeout; positive base-10 integer milliseconds.",
  },
  OPEN_LINK_MCP_TIMEOUT_MS: {
    name: "AUTOMOBILE_OPEN_LINK_MCP_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_OPEN_LINK_MCP_TIMEOUT_MS",
    kind: "int",
    default: "90000",
    min: 1,
    doc: "Floor for the openLink MCP request timeout; positive base-10 integer milliseconds.",
  },
  DEVICE_POOL_AUTOLOCK: {
    name: "AUTOMOBILE_DEVICE_POOL_AUTOLOCK",
    legacyName: "AUTO_MOBILE_DEVICE_POOL_AUTOLOCK",
    kind: "string",
    default: "off",
    doc: "Exact 1 enables device pool autolock.",
  },
  DEVICE_POOL_MATCHING: {
    name: "AUTOMOBILE_DEVICE_POOL_MATCHING",
    legacyName: "AUTO_MOBILE_DEVICE_POOL_MATCHING",
    kind: "string",
    default: "LATEST",
    doc: "Device pool matching strategy: LATEST, RANDOM or MINIMUM.",
  },
  DEVICE_POOL_TIMEOUT: {
    name: "AUTOMOBILE_DEVICE_POOL_TIMEOUT",
    legacyName: "AUTO_MOBILE_DEVICE_POOL_TIMEOUT",
    kind: "int",
    default: "60",
    min: 1,
    doc: "Device pool idle timeout in seconds; positive base-10 integer.",
  },
  DEVICE_RECOVERY_ON_LOSS: {
    name: "AUTOMOBILE_DEVICE_RECOVERY_ON_LOSS",
    legacyName: "AUTO_MOBILE_DEVICE_RECOVERY_ON_LOSS",
    kind: "string",
    default: "see docs",
    doc: "Device recovery on runtime loss; exact 0 disables session continuity.",
  },
  ANDROID_REBOOT_ON_DEATH: {
    name: "AUTOMOBILE_ANDROID_REBOOT_ON_DEATH",
    legacyName: "AUTO_MOBILE_ANDROID_REBOOT_ON_DEATH",
    kind: "string",
    default: "see docs",
    doc: "Legacy Android spelling of the device recovery switch.",
  },
  DEVICE_RECOVERY_MAX_ATTEMPTS: {
    name: "AUTOMOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS",
    legacyName: "AUTO_MOBILE_DEVICE_RECOVERY_MAX_ATTEMPTS",
    kind: "string",
    default: "2",
    doc: "Maximum device recovery attempts.",
  },
  DEVICE_RECOVERY_WINDOW_MS: {
    name: "AUTOMOBILE_DEVICE_RECOVERY_WINDOW_MS",
    legacyName: "AUTO_MOBILE_DEVICE_RECOVERY_WINDOW_MS",
    kind: "string",
    default: "see docs",
    doc: "Rolling window for the recovery attempt budget; positive base-10 integer milliseconds.",
  },
  ANDROID_APPEARANCE_SYNC_DEVICES: {
    name: "AUTOMOBILE_ANDROID_APPEARANCE_SYNC_DEVICES",
    kind: "list",
    default: "unset",
    doc: "Android device ids opted into appearance sync.",
  },
  ANDROID_OBSERVATION_STREAM_DEVICES: {
    name: "AUTOMOBILE_ANDROID_OBSERVATION_STREAM_DEVICES",
    kind: "list",
    default: "unset",
    doc: "Android device ids opted into passive observation streaming.",
  },
  IOS_WARMUP_DEVICES: {
    name: "AUTOMOBILE_IOS_WARMUP_DEVICES",
    kind: "list",
    default: "unset",
    doc: "iOS device ids opted into passive warmup.",
  },
  EVENT_ALL_MARKERS: {
    name: "AUTOMOBILE_EVENT_ALL_MARKERS",
    kind: "list",
    default: "unset",
    doc: "Comma-separated markers that auto-promote matching content to all-events output; the CLI flag wins.",
  },
  LOG_LEVEL: {
    name: "AUTOMOBILE_LOG_LEVEL",
    legacyName: "AUTO_MOBILE_LOG_LEVEL",
    kind: "string",
    default: "info",
    doc: "Initial log level: debug, info, warn, error or none.",
  },
  LOG_FORMAT: {
    name: "AUTOMOBILE_LOG_FORMAT",
    legacyName: "AUTO_MOBILE_LOG_FORMAT",
    kind: "string",
    default: "text",
    doc: "Log output format: text or json.",
  },
  LOG_SINK: {
    name: "AUTOMOBILE_LOG_SINK",
    legacyName: "AUTO_MOBILE_LOG_SINK",
    kind: "string",
    default: "file",
    doc: "Log destination: file, stderr or both.",
  },
  OBSERVE_RESULT_INCLUDE_ELEMENTS: {
    name: "AUTOMOBILE_OBSERVE_RESULT_INCLUDE_ELEMENTS",
    kind: "string",
    default: "off",
    doc: "Exact 1 restores the flattened elements array on observe results.",
  },
  TOOL_RESULTS_NO_STRUCTURED_CONTENT: {
    name: "AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT",
    kind: "string",
    default: "off",
    doc: "Exact 1 omits structuredContent from tool results.",
  },
  ACTIONS_DIFF_OBSERVE: {
    name: "AUTOMOBILE_ACTIONS_DIFF_OBSERVE",
    kind: "string",
    default: "off",
    doc: "Exact 1 attaches a diff observation to action results.",
  },
  ACTIONS_NO_OBSERVE: {
    name: "AUTOMOBILE_ACTIONS_NO_OBSERVE",
    kind: "string",
    default: "off",
    doc: "Exact 1 skips the automatic observation after actions.",
  },
  ACTIONS_COMPACT_METADATA: {
    name: "AUTOMOBILE_ACTIONS_COMPACT_METADATA",
    kind: "string",
    default: "see docs",
    doc: "Exact 0 or 1 sets the compact action metadata preference; other values are ignored.",
  },
  RUNNER_READINESS_TIMEOUT_MS: {
    name: "AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS",
    kind: "string",
    default: "30000",
    doc: "Steady-state CtrlProxy readiness budget; integer milliseconds in 1000..120000.",
  },
  TOOL_OUTPUTS_DIR: {
    name: "AUTOMOBILE_TOOL_OUTPUTS_DIR",
    legacyName: "AUTO_MOBILE_TOOL_OUTPUTS_DIR",
    kind: "path",
    default: "temp directory",
    doc: "Directory for tool-output artifacts; relative to the daemon launch directory.",
  },
  PLAN_HEALTH_DIR: {
    name: "AUTOMOBILE_PLAN_HEALTH_DIR",
    kind: "path",
    default: "unset",
    doc: "Directory that receives one health-summary JSON file per plan run.",
  },
  ENABLED_TOOLS: {
    name: "AUTOMOBILE_ENABLED_TOOLS",
    kind: "list",
    default: "unset",
    doc: "Comma-separated tool names enabled for this connection.",
  },
  DISABLED_TOOLS: {
    name: "AUTOMOBILE_DISABLED_TOOLS",
    kind: "list",
    default: "unset",
    doc: "Comma-separated tool names disabled for this connection.",
  },
  APPEARANCE_SYNC: {
    name: "AUTOMOBILE_APPEARANCE_SYNC",
    kind: "string",
    default: "on",
    doc: "Automatic appearance sync switch; off disables it.",
  },
  STARTUP_BENCHMARK: {
    name: "AUTOMOBILE_STARTUP_BENCHMARK",
    legacyName: "AUTO_MOBILE_STARTUP_BENCHMARK",
    kind: "string",
    default: "off",
    doc: "Internal startup benchmark harness activation (1, true or yes).",
  },
  STARTUP_BENCHMARK_OUTPUT: {
    name: "AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT",
    legacyName: "AUTO_MOBILE_STARTUP_BENCHMARK_OUTPUT",
    kind: "path",
    default: "unset",
    doc: "Internal startup benchmark harness output file.",
  },
  STARTUP_BENCHMARK_LABEL: {
    name: "AUTOMOBILE_STARTUP_BENCHMARK_LABEL",
    legacyName: "AUTO_MOBILE_STARTUP_BENCHMARK_LABEL",
    kind: "string",
    default: "unset",
    doc: "Internal startup benchmark harness sample label.",
  },
  DAEMON_LAUNCH_CWD: {
    name: "AUTOMOBILE_DAEMON_LAUNCH_CWD",
    kind: "path",
    default: "caller working directory",
    doc: "Internal manager-injected caller working directory for child path resolution.",
  },
  DAEMON_LAUNCH_LOG_PATH: {
    name: "AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH",
    kind: "path",
    default: "unset",
    doc: "Internal manager-injected child launch log ownership marker.",
  },
  ACCEPTANCE_LIVE: {
    name: "AUTOMOBILE_ACCEPTANCE_LIVE",
    kind: "string",
    default: "off",
    doc: "Internal live acceptance harness activation (exact 1).",
  },
  ACCEPTANCE_DISCOVERY_ORDER: {
    name: "AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER",
    kind: "string",
    default: "unset",
    doc: "Internal acceptance harness discovery ordering.",
  },
  ACCEPTANCE_DISCOVERY_CAPABILITY: {
    name: "AUTOMOBILE_ACCEPTANCE_DISCOVERY_CAPABILITY",
    kind: "string",
    default: "unset",
    doc: "Internal private acceptance discovery capability between processes.",
  },
  DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET: {
    name: "AUTOMOBILE_DAEMON_LIVE_ACCEPTANCE_STARTUP_SECRET",
    kind: "string",
    default: "unset",
    doc: "Internal private live acceptance startup secret.",
  },
  VIDEO_SERVER_JAR: {
    name: "AUTOMOBILE_VIDEO_SERVER_JAR",
    kind: "path",
    default: "cached/released JAR, then source-built JAR",
    doc: "Local Android persistent encoder JAR; untrimmed, used only if the file exists.",
  },
  REQUIRE_VIDEO_SERVER: {
    name: "AUTOMOBILE_REQUIRE_VIDEO_SERVER",
    kind: "bool",
    default: "off",
    doc: "Make an unavailable or invalid video-server JAR fatal instead of degrading to screenrecord.",
  },
  SKIP_VIDEO_SERVER_DOWNLOAD: {
    name: "AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD",
    kind: "bool",
    default: "off",
    doc: "Resolve the video-server JAR from local sources only; never touch the network.",
  },
  IOS_WEBRTC_FFMPEG: {
    name: "AUTOMOBILE_IOS_WEBRTC_FFMPEG",
    legacyName: "AUTO_MOBILE_IOS_WEBRTC_FFMPEG",
    kind: "path",
    default: "ffmpeg on PATH",
    doc: "iOS WebRTC ffmpeg executable path or name; first nonempty spelling wins.",
  },
  IOS_WEBRTC_FORCE_RAW: {
    name: "AUTOMOBILE_IOS_WEBRTC_FORCE_RAW",
    legacyName: "AUTO_MOBILE_IOS_WEBRTC_FORCE_RAW",
    kind: "bool",
    default: "off",
    doc: "Force the raw BGRA plus ffmpeg iOS capture pipeline instead of in-helper H.264.",
  },
  IOS_SIMULATOR_WINDOW_TIMEOUT_MS: {
    name: "AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS",
    kind: "int",
    default: "2000",
    min: 1,
    fallback: 2000,
    doc: "Simulator capture window target resolution budget in milliseconds.",
  },
  WEBRTC_WHIP_ENDPOINT: {
    name: "AUTOMOBILE_WEBRTC_WHIP_ENDPOINT",
    kind: "string",
    default: "unset; required to stream",
    doc: "WHIP ingest URL; HTTPS, or loopback HTTP.",
  },
  WEBRTC_WHIP_TOKEN: {
    name: "AUTOMOBILE_WEBRTC_WHIP_TOKEN",
    kind: "string",
    default: "unset",
    doc: "Bearer token for WHIP ingest.",
  },
  WEBRTC_ICE_SERVERS: {
    name: "AUTOMOBILE_WEBRTC_ICE_SERVERS",
    kind: "string",
    default: "stun:stun.l.google.com:19302",
    doc: "JSON array of RTCIceServer objects or comma-separated STUN/TURN URLs.",
  },
  WEBRTC_BITRATE_KBPS: {
    name: "AUTOMOBILE_WEBRTC_BITRATE_KBPS",
    kind: "string",
    default: "unset; encoder default",
    doc: "Positive encoder bitrate in kbps, rounded to an integer.",
  },
  WEBRTC_MAX_SIZE: {
    name: "AUTOMOBILE_WEBRTC_MAX_SIZE",
    kind: "string",
    default: "unset; source dimensions",
    doc: "Capture downscale as WIDTHxHEIGHT; positive even integers within the H.264 Level 4.2 limit.",
  },
  WEBRTC_IOS_SIMULATOR_FPS: {
    name: "AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS",
    kind: "string",
    default: "15",
    doc: "iOS Simulator WebRTC capture rate; integer 5..60.",
  },
  WEBRTC_ANDROID_FPS: {
    name: "AUTOMOBILE_WEBRTC_ANDROID_FPS",
    kind: "string",
    default: "30",
    doc: "Android video-server capture rate; integer 1..60.",
  },
  WEBRTC_TRICKLE_ICE: {
    name: "AUTOMOBILE_WEBRTC_TRICKLE_ICE",
    kind: "bool",
    default: "off",
    doc: "Publish the WHIP offer immediately and trickle ICE candidates via PATCH.",
  },
  WEBRTC_AUDIO: {
    name: "AUTOMOBILE_WEBRTC_AUDIO",
    kind: "bool",
    default: "off",
    doc: "Add an audio track alongside video.",
  },
  WEBRTC_ALLOW_INSECURE_WHIP: {
    name: "AUTOMOBILE_WEBRTC_ALLOW_INSECURE_WHIP",
    kind: "bool",
    default: "off",
    doc: "Permit non-loopback HTTP and arbitrary wire WHIP overrides (#4751 escape hatch).",
  },
  WEBRTC_WHIP_ALLOWED_ORIGINS: {
    name: "AUTOMOBILE_WEBRTC_WHIP_ALLOWED_ORIGINS",
    kind: "list",
    default: "empty additional allowlist",
    doc: "Comma-separated origins or bare host[:port] allowed for wire WHIP overrides.",
  },
} as const satisfies Record<string, EnvVarSpec>;

/**
 * Ambient variables owned by the OS or the Android toolchain, not by AutoMobile. They are
 * declared and read through the same readers, but kept apart from {@link ENV} because the
 * product-variable conformance checks (AUTOMOBILE_ prefix, path classification) do not apply.
 */
export const AMBIENT_ENV = {
  ANDROID_HOME: {
    name: "ANDROID_HOME",
    kind: "path",
    default: "unset",
    doc: "Android SDK root; ambient Android toolchain variable, read for emulator resolution.",
  },
  ANDROID_SDK_ROOT: {
    name: "ANDROID_SDK_ROOT",
    kind: "path",
    default: "unset",
    doc: "Android SDK root (deprecated by Google); ambient, read for emulator resolution.",
  },
  ANDROID_SDK_HOME: {
    name: "ANDROID_SDK_HOME",
    kind: "path",
    default: "unset",
    doc: "Android user-data home; ambient, reported in emulator-not-found diagnostics.",
  },
  HOME: {
    name: "HOME",
    kind: "path",
    default: "unset",
    doc: "POSIX home directory; ambient, used to probe the default Android SDK locations.",
  },
  USERPROFILE: {
    name: "USERPROFILE",
    kind: "path",
    default: "unset",
    doc: "Windows home directory; ambient, fallback when HOME is unset or empty.",
  },
  PATH: {
    name: "PATH",
    kind: "string",
    default: "unset",
    doc: "Executable search path; ambient, reported in emulator-not-found diagnostics.",
  },
  ADB_SERVER_SOCKET: {
    name: "ADB_SERVER_SOCKET",
    kind: "string",
    default: "unset",
    doc: "ADB server endpoint (tcp:host:port or local socket); ambient Android toolchain variable.",
  },
  ANDROID_ADB_SERVER_ADDRESS: {
    name: "ANDROID_ADB_SERVER_ADDRESS",
    kind: "string",
    default: "localhost",
    doc: "ADB server host; ambient Android toolchain variable.",
  },
  ANDROID_ADB_SERVER_PORT: {
    name: "ANDROID_ADB_SERVER_PORT",
    kind: "string",
    default: "5037",
    doc: "ADB server port; ambient Android toolchain variable.",
  },
  LOCALAPPDATA: {
    name: "LOCALAPPDATA",
    kind: "path",
    default: "unset",
    doc: "Windows local application data directory; ambient, used to locate emulator advertisements.",
  },
  MCP_SERVER_VERSION: {
    name: "MCP_SERVER_VERSION",
    kind: "string",
    default: "unset",
    doc: "Exact MCP server version override for CI and tests; ambient pin, not AutoMobile-prefixed.",
  },
  npm_package_version: {
    name: "npm_package_version",
    kind: "string",
    default: "unset",
    doc: "Package version exported by npm and bun run; ambient, last-resort version fallback.",
  },
} as const satisfies Record<string, EnvVarSpec>;

export const ENV_REGISTRY: readonly EnvVarSpec[] = Object.values(ENV);
export const AMBIENT_ENV_REGISTRY: readonly EnvVarSpec[] = Object.values(AMBIENT_ENV);

/**
 * Raw value of a variable: the canonical name wins whenever it is set (even to
 * an empty string), otherwise the legacy spelling is consulted.
 */
export function readEnvRaw(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return env[spec.name] ?? (spec.legacyName === undefined ? undefined : env[spec.legacyName]);
}

/** Trimmed value, or undefined when unset or blank. */
export function readEnvTrimmed(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readEnvRaw(spec, env)?.trim();
  return value ? value : undefined;
}

/** Lowercase `1` / `true` / `yes` (trimmed) are true; anything else, including unset, is false. */
export function readEnvBool(spec: EnvVarSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = readEnvRaw(spec, env)?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/**
 * Lenient finite number (fractions allowed), bounded by `spec.min`. Undefined when the
 * variable is unset/blank (not reported) or unusable (`onInvalid` receives the raw text).
 */
export function readEnvNumber(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (raw: string) => void,
): number | undefined {
  const raw = readEnvTrimmed(spec, env);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = Number(raw);
  const min = spec.min ?? Number.NEGATIVE_INFINITY;
  if (Number.isFinite(parsed) && (spec.minExclusive ? parsed > min : parsed >= min)) {
    return parsed;
  }
  onInvalid?.(raw);
  return undefined;
}

/** Trimmed, lowercased value when it is one of `spec.values`, else undefined. */
export function readEnvEnum(
  spec: EnvVarSpec,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = readEnvTrimmed(spec, env)?.toLowerCase();
  return value !== undefined && spec.values?.includes(value) ? value : undefined;
}

/** Comma-separated list with entries trimmed and blanks dropped. */
export function readEnvList(spec: EnvVarSpec, env: NodeJS.ProcessEnv = process.env): string[] {
  return (readEnvTrimmed(spec, env) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}
