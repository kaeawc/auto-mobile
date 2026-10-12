/** Product path reads audited against the AST conformance scanner. */
export interface ProductPathEnvVariable {
  name: string;
  kind: "state" | "unset" | "input";
  owner?: "harness";
  scope?: "daemon" | "batch";
  subpath?: string;
  reason?: string;
}
export const PRODUCT_PATH_ENV_VARIABLES: readonly ProductPathEnvVariable[] = [
  { name: "AUTOMOBILE_DATA_DIR", kind: "state", owner: "harness", scope: "daemon" },
  { name: "AUTOMOBILE_LOG_DIR", kind: "state", owner: "harness", scope: "daemon" },
  { name: "AUTOMOBILE_DB_DIR", kind: "state", owner: "harness", scope: "daemon" },
  { name: "AUTOMOBILE_COORDINATION_DIR", kind: "state", owner: "harness", scope: "daemon" },
  {
    name: "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR",
    kind: "state",
    owner: "harness",
    scope: "batch",
  },
  { name: "AUTOMOBILE_AUX_SOCKET_DIR", kind: "state", owner: "harness", scope: "daemon" },
  { name: "AUTOMOBILE_DAEMON_SOCKET_PATH", kind: "state", owner: "harness", scope: "daemon" },
  { name: "AUTOMOBILE_DAEMON_PID_FILE_PATH", kind: "state", owner: "harness", scope: "daemon" },
  { name: "AUTOMOBILE_DAEMON_LOCK_FILE_PATH", kind: "state", owner: "harness", scope: "daemon" },
  { name: "AUTOMOBILE_DAEMON_LAUNCH_LOG_PATH", kind: "state", owner: "harness", scope: "daemon" },
  {
    name: "AUTOMOBILE_CTRL_PROXY_IOS_CACHE_DIR",
    kind: "state",
    scope: "daemon",
    subpath: "ctrl-proxy-ios",
  },
  {
    name: "AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA",
    kind: "state",
    scope: "daemon",
    subpath: "derived-data",
  },
  {
    name: "AUTOMOBILE_IOS_CTRLPROXY_RECORD_DIR",
    kind: "state",
    scope: "daemon",
    subpath: "recordings",
  },
  { name: "AUTOMOBILE_PLAN_HEALTH_DIR", kind: "state", scope: "daemon", subpath: "plan-health" },
  { name: "AUTOMOBILE_TOOL_OUTPUTS_DIR", kind: "state", scope: "daemon", subpath: "tool-outputs" },
  {
    name: "AUTOMOBILE_DB_PATH",
    kind: "unset",
    reason: "DB_DIR isolates the database; remove this competing override.",
  },
  {
    name: "AUTOMOBILE_WEBRTC_STREAM_SOCKET_PATH",
    kind: "unset",
    reason: "AUX_SOCKET_DIR isolates the socket; remove this competing override.",
  },
  { name: "AUTOMOBILE_CTRL_PROXY_APK_PATH", kind: "input", reason: "Read-only APK artifact." },
  {
    name: "AUTOMOBILE_CTRL_PROXY_IOS_BUNDLE_PATH",
    kind: "input",
    reason: "Read-only runner bundle.",
  },
  { name: "AUTOMOBILE_CTRL_PROXY_IOS_IPA_PATH", kind: "input", reason: "Read-only IPA artifact." },
  { name: "AUTOMOBILE_CWEBP_PATH", kind: "input", reason: "Read-only codec executable." },
  { name: "AUTOMOBILE_DWEBP_PATH", kind: "input", reason: "Read-only codec executable." },
  {
    name: "AUTOMOBILE_DAEMON_LAUNCH_CWD",
    kind: "input",
    reason: "Caller working directory for relative path resolution, not a state destination.",
  },
  {
    name: "AUTOMOBILE_IOS_CODE_SIGN_ENTITLEMENTS_PATH",
    kind: "input",
    reason: "Read-only signing input.",
  },
  { name: "AUTOMOBILE_MIGRATIONS_DIR", kind: "input", reason: "Read-only SQL migration source." },
  {
    name: "AUTOMOBILE_NETWORK_FILTER_APP_PATH",
    kind: "input",
    reason: "Read-only signed application artifact.",
  },
  {
    name: "AUTOMOBILE_PROJECT_ROOT",
    kind: "input",
    reason: "Read-only local source build location.",
  },
  {
    name: "AUTOMOBILE_STARTUP_BENCHMARK_OUTPUT",
    kind: "input",
    reason: "Explicit benchmark harness artifact, not normal daemon state.",
  },
  {
    name: "AUTOMOBILE_UNIT_TEST_ISOLATED_DATA_DIR",
    kind: "input",
    reason: "Test preload isolation marker, not a state destination.",
  },
  {
    name: "AUTOMOBILE_MANAGED_SLOT_CONFIG",
    kind: "input",
    reason:
      "Read-only managed-slot config source (inline JSON or file path); explicitly unset by clients.",
  },
  {
    name: "AUTOMOBILE_FFMPEG",
    kind: "input",
    reason: "Read-only executable path or command name.",
  },
  {
    name: "AUTOMOBILE_IOS_WEBRTC_FFMPEG",
    kind: "input",
    reason: "Read-only executable path or command name.",
  },
  { name: "AUTOMOBILE_VIDEO_SERVER_JAR", kind: "input", reason: "Read-only encoder JAR." },
  {
    name: "AUTOMOBILE_IOS_SCREEN_CAPTURE_HELPER",
    kind: "input",
    reason: "Read-only helper executable.",
  },
  { name: "AUTOMOBILE_IOS_PROTOTYPE_AGENT", kind: "input", reason: "Read-only agent dylib." },
];
export const STATE_PATH_VARIABLES = PRODUCT_PATH_ENV_VARIABLES.filter(
  (row) => row.kind === "state",
).map((row) => row.name);
