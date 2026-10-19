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
  /** Test, acceptance or manager-injected hook: registered but deliberately not in the public docs. */
  readonly internal?: boolean;
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
  VERSION: {
    name: "AUTOMOBILE_VERSION",
    kind: "string",
    default: "latest",
    doc: "Pins the daemon, APK and IPA to one coherent release version.",
  },
  ASSET_BASE_URL: {
    name: "AUTOMOBILE_ASSET_BASE_URL",
    kind: "string",
    default: "GitHub Releases",
    doc: "Mirror for APK/IPA and other release asset downloads; absolute https URL.",
  },
  ALLOW_INSECURE_ASSET_URL: {
    name: "AUTOMOBILE_ALLOW_INSECURE_ASSET_URL",
    kind: "bool",
    default: "off",
    doc: "Permit a plaintext http asset base/bundle URL for a trusted loopback or dev mirror (1/true).",
  },
  ANDROID_MAX_BOOTED: {
    name: "AUTOMOBILE_ANDROID_MAX_BOOTED",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "Positive integer cap on concurrently booted Android emulators.",
  },
  IOS_SIM_MAX_BOOTED: {
    name: "AUTOMOBILE_IOS_SIM_MAX_BOOTED",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "Positive integer cap on concurrently booted iOS simulators.",
  },
  NETWORK_FILTER_APP_PATH: {
    name: "AUTOMOBILE_NETWORK_FILTER_APP_PATH",
    kind: "path",
    default: "unset",
    doc: "Path to a locally built signed network-filter .app used instead of the release download.",
  },
  NETWORK_FILTER_TEAM_ID: {
    name: "AUTOMOBILE_NETWORK_FILTER_TEAM_ID",
    kind: "string",
    default: "unset",
    doc: "Apple team id used to sign the network-filter app.",
  },
  UNIT_TEST_ISOLATED_DATA_DIR: {
    name: "AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR",
    kind: "path",
    default: "unset",
    doc: "Test-only: the data directory the unit-test preload isolated, exempt from the real-data-dir guard.",
  },
  IOS_TAP_STRATEGY: {
    name: "AUTOMOBILE_IOS_TAP_STRATEGY",
    kind: "string",
    default: "unset",
    doc: "iOS tap coordinate strategy recorded in debug tap diagnostics.",
  },
  CTRL_PROXY_LEASE_IDLE_MS: {
    name: "AUTOMOBILE_CTRL_PROXY_LEASE_IDLE_MS",
    kind: "int",
    default: "60000",
    min: 1,
    doc: "Idle window in ms after which a daemon gives up a CtrlProxy forwarding lease.",
  },
  IOS_PROTOTYPE_AGENT: {
    name: "AUTOMOBILE_IOS_PROTOTYPE_AGENT",
    kind: "path",
    default: "unset",
    doc: "Absolute path to a locally built iOS prototype-agent dylib.",
  },
  SKIP_IOS_PROTOTYPE_AGENT_DOWNLOAD: {
    name: "AUTOMOBILE_SKIP_IOS_PROTOTYPE_AGENT_DOWNLOAD",
    kind: "bool",
    default: "off",
    doc: "Forbid the prototype-agent release download (1/true).",
  },
  IOS_PROTOTYPE_VIEWER: {
    name: "AUTOMOBILE_IOS_PROTOTYPE_VIEWER",
    kind: "path",
    default: "unset",
    doc: "Path to a locally built iOS prototype-viewer template.",
  },
  SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD: {
    name: "AUTOMOBILE_SKIP_IOS_PROTOTYPE_VIEWER_DOWNLOAD",
    kind: "bool",
    default: "off",
    doc: "Forbid the prototype-viewer release download (1/true).",
  },
  ANDROID_VIDEO_USE_FFMPEG_PIPE: {
    name: "AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE",
    kind: "bool",
    default: "off",
    doc: "Capture Android video through an exec-out screenrecord to ffmpeg pipe (1/true).",
  },
  MANAGED_ADB_SERVER: {
    name: "AUTOMOBILE_MANAGED_ADB_SERVER",
    legacyName: "AUTO_MOBILE_MANAGED_ADB_SERVER",
    kind: "string",
    default: "see docs",
    doc: "Whether AutoMobile manages (starts and stops) its own ADB server.",
  },
  EMULATOR_HEADLESS: {
    name: "AUTOMOBILE_EMULATOR_HEADLESS",
    kind: "string",
    default: "host dependent",
    doc: "Exact true forces headless emulator launches; exact false forces a windowed launch.",
  },
  EMULATOR_ARGS: {
    name: "AUTOMOBILE_EMULATOR_ARGS",
    kind: "string",
    default: "unset",
    doc: "Extra whitespace-separated arguments appended to emulator launches.",
  },
  SKIP_CTRL_PROXY_DOWNLOAD: {
    name: "AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD",
    kind: "bool",
    default: "off",
    doc: "Skip CtrlProxy APK and IPA downloads (1/true).",
  },
  ACCEPTANCE_LIVE: {
    name: "AUTOMOBILE_ACCEPTANCE_LIVE",
    kind: "string",
    default: "off",
    internal: true,
    doc: "Live acceptance harness activation; exact 1 enables.",
  },
  ACCEPTANCE_DISCOVERY_ORDER: {
    name: "AUTOMOBILE_ACCEPTANCE_DISCOVERY_ORDER",
    kind: "string",
    default: "unset",
    internal: true,
    doc: "Acceptance harness discovery ordering.",
  },
  OBSERVE_RESULT_INCLUDE_ELEMENTS: {
    name: "AUTOMOBILE_OBSERVE_RESULT_INCLUDE_ELEMENTS",
    kind: "bool",
    default: "off",
    doc: "Include the element list in observe results (output-reduction flag).",
  },
  TOOL_RESULTS_NO_STRUCTURED_CONTENT: {
    name: "AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT",
    kind: "bool",
    default: "off",
    doc: "Omit structuredContent from tool results (output-reduction flag).",
  },
  ACTIONS_DIFF_OBSERVE: {
    name: "AUTOMOBILE_ACTIONS_DIFF_OBSERVE",
    kind: "bool",
    default: "off",
    doc: "Return a diff observation from actions (output-reduction flag).",
  },
  ACTIONS_NO_OBSERVE: {
    name: "AUTOMOBILE_ACTIONS_NO_OBSERVE",
    kind: "bool",
    default: "off",
    doc: "Skip the post-action observation (output-reduction flag).",
  },
  ACTIONS_COMPACT_METADATA: {
    name: "AUTOMOBILE_ACTIONS_COMPACT_METADATA",
    kind: "bool",
    default: "on",
    doc: "Compact action result metadata (output-reduction flag).",
  },
  ALLOW_DEVICE_CREATE: {
    name: "AUTOMOBILE_ALLOW_DEVICE_CREATE",
    kind: "bool",
    default: "off",
    doc: "Enable device creation when no explicit flag is supplied (1/true).",
  },
  ALLOW_REAL_CTRL_PROXY_WEBSOCKET: {
    name: "AUTOMOBILE_ALLOW_REAL_CTRL_PROXY_WEBSOCKET",
    kind: "bool",
    default: "off",
    internal: true,
    doc: "Test-only opt-in to a real CtrlProxy WebSocket.",
  },
  BOOT_CAPACITY_GATE: {
    name: "AUTOMOBILE_BOOT_CAPACITY_GATE",
    kind: "string",
    default: "on",
    doc: "Boot admission gate for every platform; exact 0 disables.",
  },
  IOS_SIM_CAPACITY_GATE: {
    name: "AUTOMOBILE_IOS_SIM_CAPACITY_GATE",
    kind: "string",
    default: "follows boot gate",
    doc: "iOS-only override of the boot admission gate; exact 0 disables, exact 1 enables.",
  },
  CWEBP_PATH: {
    name: "AUTOMOBILE_CWEBP_PATH",
    kind: "path",
    default: "unset",
    doc: "Trusted cwebp binary used instead of PATH or the bundled copy.",
  },
  DWEBP_PATH: {
    name: "AUTOMOBILE_DWEBP_PATH",
    kind: "path",
    default: "unset",
    doc: "Trusted dwebp binary used instead of PATH or the bundled copy.",
  },
  DAEMON_LAUNCH_CWD: {
    name: "AUTOMOBILE_DAEMON_LAUNCH_CWD",
    kind: "path",
    default: "unset",
    internal: true,
    doc: "Manager-injected caller working directory for child path resolution.",
  },
  EVENT_ALL_MARKERS: {
    name: "AUTOMOBILE_EVENT_ALL_MARKERS",
    kind: "list",
    default: "unset",
    doc: "Marker names recorded for every event.",
  },
  FFMPEG: {
    name: "AUTOMOBILE_FFMPEG",
    kind: "path",
    default: "ffmpeg",
    doc: "ffmpeg binary used for video processing.",
  },
  IOS_CODE_SIGN_ENTITLEMENTS_PATH: {
    name: "AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH",
    kind: "path",
    default: "generated",
    doc: "Entitlements plist used when signing iOS builds.",
  },
  IOS_CODE_SIGN_IDENTITY: {
    name: "AUTOMOBILE_IOS_CODE_SIGN_IDENTITY",
    kind: "string",
    default: "unset",
    doc: "Preferred code-signing identity for iOS builds.",
  },
  IOS_PROFILE_UUID: {
    name: "AUTOMOBILE_IOS_PROFILE_UUID",
    kind: "string",
    default: "unset",
    doc: "Preferred provisioning profile UUID for iOS builds.",
  },
  IOS_PROFILE_NAME: {
    name: "AUTOMOBILE_IOS_PROFILE_NAME",
    kind: "string",
    default: "unset",
    doc: "Preferred provisioning profile name for iOS builds.",
  },
  IOS_PROFILE_SPECIFIER: {
    name: "AUTOMOBILE_IOS_PROFILE_SPECIFIER",
    kind: "string",
    default: "unset",
    doc: "Preferred provisioning profile specifier for iOS builds.",
  },
  IOS_TEAM_IDS: {
    name: "AUTOMOBILE_IOS_TEAM_IDS",
    kind: "list",
    default: "unset",
    doc: "Comma-separated preferred Apple team ids for iOS signing.",
  },
  IOS_TEAM_ID: {
    name: "AUTOMOBILE_IOS_TEAM_ID",
    kind: "string",
    default: "unset",
    doc: "Preferred Apple team id for iOS signing; consulted when AUTOMOBILE_IOS_TEAM_IDS is unset.",
  },
  IOS_CTRLPROXY_RECORD_DIR: {
    name: "AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR",
    kind: "path",
    default: "unset",
    doc: "Directory where the iOS client records CtrlProxy exchanges.",
  },
  IOS_HEADLESS: {
    name: "AUTOMOBILE_IOS_HEADLESS",
    kind: "string",
    default: "detected",
    doc: "Force headless (true/1) or windowed iOS simulator launches on macOS.",
  },
  IOS_SIMULATOR_WINDOW_TIMEOUT_MS: {
    name: "AUTOMOBILE_IOS_SIMULATOR_WINDOW_TIMEOUT_MS",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "Timeout in ms for the iOS simulator window to appear.",
  },
  IOS_WEBRTC_FFMPEG: {
    name: "AUTOMOBILE_IOS_WEBRTC_FFMPEG",
    legacyName: "AUTO_MOBILE_IOS_WEBRTC_FFMPEG",
    kind: "path",
    default: "ffmpeg",
    doc: "ffmpeg binary used for iOS WebRTC streaming.",
  },
  IOS_WEBRTC_FORCE_RAW: {
    name: "AUTOMOBILE_IOS_WEBRTC_FORCE_RAW",
    legacyName: "AUTO_MOBILE_IOS_WEBRTC_FORCE_RAW",
    kind: "bool",
    default: "off",
    doc: "Force the raw iOS WebRTC capture path (1/true).",
  },
  LOG_FORMAT: {
    name: "AUTOMOBILE_LOG_FORMAT",
    legacyName: "AUTO_MOBILE_LOG_FORMAT",
    kind: "enum",
    default: "text",
    values: ["text", "json"],
    doc: "Log serialization: text or json.",
  },
  LOG_SINK: {
    name: "AUTOMOBILE_LOG_SINK",
    legacyName: "AUTO_MOBILE_LOG_SINK",
    kind: "enum",
    default: "file",
    values: ["file", "stderr", "both"],
    doc: "Log destination: file, stderr or both.",
  },
  LOG_LEVEL: {
    name: "AUTOMOBILE_LOG_LEVEL",
    legacyName: "AUTO_MOBILE_LOG_LEVEL",
    kind: "string",
    default: "info",
    doc: "Initial logging threshold: debug, info, warn, error or none.",
  },
  PLAN_HEALTH_DIR: {
    name: "AUTOMOBILE_PLAN_HEALTH_DIR",
    kind: "path",
    default: "unset",
    doc: "Directory where executePlan writes a JSON health summary.",
  },
  REQUIRE_VIDEO_SERVER: {
    name: "AUTOMOBILE_REQUIRE_VIDEO_SERVER",
    kind: "bool",
    default: "off",
    doc: "Fail instead of degrading when no verifiable video-server jar is available (1/true).",
  },
  SKIP_VIDEO_SERVER_DOWNLOAD: {
    name: "AUTOMOBILE_SKIP_VIDEO_SERVER_DOWNLOAD",
    kind: "bool",
    default: "off",
    doc: "Resolve video-server jar from local sources only (1/true).",
  },
  VIDEO_SERVER_JAR: {
    name: "AUTOMOBILE_VIDEO_SERVER_JAR",
    kind: "path",
    default: "unset",
    doc: "Explicit local video-server jar override.",
  },
  RUNNER_READINESS_TIMEOUT_MS: {
    name: "AUTOMOBILE_RUNNER_READINESS_TIMEOUT_MS",
    legacyName: "AUTO_MOBILE_RUNNER_READINESS_TIMEOUT_MS",
    kind: "int",
    default: "see docs",
    min: 1,
    doc: "iOS runner readiness timeout in ms.",
  },
  STARTUP_BENCHMARK: {
    name: "AUTOMOBILE_STARTUP_BENCHMARK",
    legacyName: "AUTO_MOBILE_STARTUP_BENCHMARK",
    kind: "bool",
    default: "off",
    internal: true,
    doc: "Startup benchmark harness activation (1/true/yes).",
  },
  STARTUP_BENCHMARK_OUTPUT: {
    name: "AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT",
    legacyName: "AUTO_MOBILE_STARTUP_BENCHMARK_OUTPUT",
    kind: "path",
    default: "unset",
    internal: true,
    doc: "Startup benchmark harness output file.",
  },
  STARTUP_BENCHMARK_LABEL: {
    name: "AUTOMOBILE_STARTUP_BENCHMARK_LABEL",
    legacyName: "AUTO_MOBILE_STARTUP_BENCHMARK_LABEL",
    kind: "string",
    default: "unset",
    internal: true,
    doc: "Startup benchmark harness sample label.",
  },
  TEST_MODE: {
    name: "AUTOMOBILE_TEST_MODE",
    kind: "string",
    default: "unset",
    internal: true,
    doc: "ADB test fake activation, not a device configuration option.",
  },
  TOOL_OUTPUTS_DIR: {
    name: "AUTOMOBILE_TOOL_OUTPUTS_DIR",
    legacyName: "AUTO_MOBILE_TOOL_OUTPUTS_DIR",
    kind: "path",
    default: "data directory tool_outputs",
    doc: "Directory for large CLI tool-output artifacts.",
  },
  WEBRTC_WHIP_ENDPOINT: {
    name: "AUTOMOBILE_WEBRTC_WHIP_ENDPOINT",
    kind: "string",
    default: "unset",
    doc: "Default WHIP endpoint for WebRTC streaming.",
  },
  WEBRTC_WHIP_TOKEN: {
    name: "AUTOMOBILE_WEBRTC_WHIP_TOKEN",
    kind: "string",
    default: "unset",
    doc: "Default WHIP bearer token.",
  },
  WEBRTC_ICE_SERVERS: {
    name: "AUTOMOBILE_WEBRTC_ICE_SERVERS",
    kind: "string",
    default: "Google STUN",
    doc: "ICE servers as a JSON array or comma-separated URL list.",
  },
  WEBRTC_BITRATE_KBPS: {
    name: "AUTOMOBILE_WEBRTC_BITRATE_KBPS",
    kind: "string",
    default: "see docs",
    doc: "Default WebRTC video bitrate in kbps.",
  },
  WEBRTC_MAX_SIZE: {
    name: "AUTOMOBILE_WEBRTC_MAX_SIZE",
    kind: "string",
    default: "see docs",
    doc: "Default WebRTC maximum frame size.",
  },
  WEBRTC_IOS_SIMULATOR_FPS: {
    name: "AUTOMOBILE_WEBRTC_IOS_SIMULATOR_FPS",
    kind: "string",
    default: "see docs",
    doc: "iOS Simulator capture fps for WebRTC.",
  },
  WEBRTC_ANDROID_FPS: {
    name: "AUTOMOBILE_WEBRTC_ANDROID_FPS",
    kind: "string",
    default: "see docs",
    doc: "Android capture fps for WebRTC.",
  },
  WEBRTC_TRICKLE_ICE: {
    name: "AUTOMOBILE_WEBRTC_TRICKLE_ICE",
    kind: "bool",
    default: "off",
    doc: "Enable trickle ICE for WebRTC streaming.",
  },
  WEBRTC_AUDIO: {
    name: "AUTOMOBILE_WEBRTC_AUDIO",
    kind: "bool",
    default: "off",
    doc: "Enable audio for WebRTC streaming.",
  },
  WEBRTC_ALLOW_INSECURE_WHIP: {
    name: "AUTOMOBILE_WEBRTC_ALLOW_INSECURE_WHIP",
    kind: "bool",
    default: "off",
    doc: "Re-permit plaintext http WHIP endpoints on non-loopback hosts.",
  },
  WEBRTC_WHIP_ALLOWED_ORIGINS: {
    name: "AUTOMOBILE_WEBRTC_WHIP_ALLOWED_ORIGINS",
    kind: "list",
    default: "unset",
    doc: "Allow-list of origins a wire-supplied WHIP endpoint may target.",
  },
  CTRL_PROXY_IOS_IPA_PATH: {
    name: "AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH",
    kind: "path",
    default: "unset",
    doc: "Vendored iOS CtrlProxy IPA; takes precedence over the bundle path.",
  },
  CTRL_PROXY_IOS_BUNDLE_PATH: {
    name: "AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH",
    kind: "path",
    default: "unset",
    doc: "Vendored iOS CtrlProxy bundle directory.",
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
  JAVA_HOME: {
    name: "JAVA_HOME",
    kind: "path",
    default: "unset",
    doc: "Java installation root; ambient, checked by doctor.",
  },
  ANTHROPIC_API_KEY: {
    name: "ANTHROPIC_API_KEY",
    kind: "string",
    default: "unset",
    doc: "Anthropic API key for vision features; ambient, used when no key is configured explicitly.",
  },
  DISPLAY: {
    name: "DISPLAY",
    kind: "string",
    default: "unset",
    doc: "X11 display; ambient, a usable value keeps Linux emulator launches windowed.",
  },
  WAYLAND_DISPLAY: {
    name: "WAYLAND_DISPLAY",
    kind: "string",
    default: "unset",
    doc: "Wayland display; ambient, a usable value keeps Linux emulator launches windowed.",
  },
  USER: {
    name: "USER",
    kind: "string",
    default: "unset",
    doc: "POSIX account name; ambient, locates the emulator advertisement directory.",
  },
  LOGNAME: {
    name: "LOGNAME",
    kind: "string",
    default: "unset",
    doc: "POSIX login name; ambient, fallback when USER is unset.",
  },
  XDG_RUNTIME_DIR: {
    name: "XDG_RUNTIME_DIR",
    kind: "path",
    default: "unset",
    doc: "Linux per-user runtime directory; ambient, locates emulator advertisements.",
  },
  ANDROID_AVD_HOME: {
    name: "ANDROID_AVD_HOME",
    kind: "path",
    default: "unset",
    doc: "Android AVD home override; ambient, used to locate AVD definitions.",
  },
  ANDROID_EMULATOR_HOME: {
    name: "ANDROID_EMULATOR_HOME",
    kind: "path",
    default: "unset",
    doc: "Android emulator home override; ambient, used to locate AVD definitions.",
  },
  ANDROID_USER_HOME: {
    name: "ANDROID_USER_HOME",
    kind: "path",
    default: "unset",
    doc: "Android user home override; ambient, used to locate AVD definitions.",
  },
  CI: {
    name: "CI",
    kind: "string",
    default: "unset",
    doc: "Set to true on CI hosts; ambient.",
  },
  GITHUB_ACTIONS: {
    name: "GITHUB_ACTIONS",
    kind: "string",
    default: "unset",
    doc: "Set to true inside GitHub Actions; ambient.",
  },
  GITHUB_WORKSPACE: {
    name: "GITHUB_WORKSPACE",
    kind: "path",
    default: "unset",
    doc: "GitHub Actions checkout directory; ambient.",
  },
  COMSPEC: {
    name: "ComSpec",
    legacyName: "COMSPEC",
    kind: "path",
    default: "cmd.exe",
    doc: "Windows command interpreter; ambient.",
  },
  DEBUG_ADB_EXEC: {
    name: "DEBUG_ADB_EXEC",
    kind: "string",
    default: "unset",
    doc: "Any value logs real adb execution with stack traces; ambient debug aid.",
  },
  EMULATOR_POLLING_INTERVAL_MS: {
    name: "EMULATOR_POLLING_INTERVAL_MS",
    kind: "string",
    default: "500",
    doc: "Emulator readiness polling interval in ms (minimum 100).",
  },
  LOCALAPPDATA: {
    name: "LOCALAPPDATA",
    kind: "path",
    default: "unset",
    doc: "Windows local app data directory; ambient.",
  },
  MCP_SERVER_VERSION: {
    name: "MCP_SERVER_VERSION",
    kind: "string",
    default: "unset",
    doc: "Exact override of the reported MCP server version (CI/test pin).",
  },
  NPM_PACKAGE_VERSION: {
    name: "npm_package_version",
    kind: "string",
    default: "unset",
    doc: "Package version exported by npm; ambient fallback for the MCP server version.",
  },
  NODE_ENV: {
    name: "NODE_ENV",
    kind: "string",
    default: "unset",
    doc: "Runtime mode; ambient, exact test arms the test-only guards and defaults.",
  },
  WINDOWS_PATH: {
    name: "Path",
    kind: "string",
    default: "unset",
    doc: "Windows spelling of PATH; ambient, consulted when PATH is unset.",
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
