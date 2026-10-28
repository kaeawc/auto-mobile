/**
 * Build the per-run MCP config and the `claude -p` argument vector.
 *
 * Isolation contract (mirrors what the run must not inherit):
 * - `--strict-mcp-config` with a generated config, so user/project MCP servers
 *   never join the run.
 * - Claude runs from an empty temp directory outside the repository: Claude Code
 *   loads CLAUDE.md from the cwd and every ancestor, so a cwd under the checkout
 *   (even the artifact directory) would still pick up this repository's context.
 *   CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 and CLAUDE_CODE_DISABLE_POLICY_SKILLS=1 are forced as
 *   well, so the operator's user-level ~/.claude/CLAUDE.md, auto-memory, and any managed
 *   policy skills on the host never shape a run, and
 *   `--setting-sources project,local` skips user settings (hooks, enabled plugins);
 *   the empty cwd has no project or local settings.
 * - The auto-mobile server talks to a private daemon (`AUTOMOBILE_AUX_SOCKET_DIR`)
 *   with a fresh database and its own log directory, so a resident daemon or a
 *   learned navigation graph from an earlier run cannot change the result. Every
 *   inherited AutoMobile variable (current `AUTOMOBILE_*` and legacy `AUTO_MOBILE_*`
 *   names) is stripped first: state overrides such as AUTOMOBILE_DB_PATH would win
 *   over the run's values, and settings such as AUTOMOBILE_DISABLED_TOOLS would
 *   silently change the agent's toolset. The ADB coordination directory is the one
 *   exception: device claims must stay shared with any resident daemon.
 * - The prompt is passed on stdin, never as a positional argument, because the
 *   variadic `--allowedTools`/`--disallowedTools` flags would swallow it.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { MCP_SERVER_NAME, type SuiteDefinition } from "./config";

/** The one AutoMobile setting shared with any resident daemon: device claims. */
const SHARED_AUTOMOBILE_VARIABLES = new Set([
  "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR",
  // Legacy spelling the env registry still honors; dropping it would move the private
  // daemon's claim root away from the one the harness checked.
  "AUTO_MOBILE_ADB_SERVER_COORDINATION_DIR",
]);

/** Orphaned private daemons shut down after this idle window once Claude exits. */
const PRIVATE_DAEMON_ORPHAN_IDLE_MS = "5000";

export interface ServerPaths {
  /** Interpreter that runs the server entry (the current bun). */
  runtime: string;
  /** Absolute path to `dist/src/index.js`. */
  serverEntry: string;
  /** Short private directory for daemon aux sockets (kept under the sun_path limit). */
  auxSocketDir: string;
  /** Private AUTOMOBILE_DATA_DIR for caches, temp files and other per-run state. */
  dataDir: string;
  dbDir: string;
  logDir: string;
}

export function privateServerEnv(paths: ServerPaths): Record<string, string> {
  return {
    AUTOMOBILE_AUX_SOCKET_DIR: paths.auxSocketDir,
    AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
    AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: PRIVATE_DAEMON_ORPHAN_IDLE_MS,
    // Device coordination and claims ignore this and stay under the shared root.
    AUTOMOBILE_DATA_DIR: paths.dataDir,
    AUTOMOBILE_DB_DIR: paths.dbDir,
    AUTOMOBILE_LOG_DIR: paths.logDir,
  };
}

/** Per-run server switches the harness writes into the MCP config, set from CLI flags. */
export interface ServerSwitches {
  /** Arm B of the instructions A/B: the server returns its `instructions` block. */
  instructions?: boolean;
}

function serverSwitchEnv(switches: ServerSwitches): Record<string, string> {
  return switches.instructions === true ? { AUTOMOBILE_SERVER_INSTRUCTIONS: "1" } : {};
}

function isAutoMobileVariable(key: string): boolean {
  return key.startsWith("AUTOMOBILE_") || key.startsWith("AUTO_MOBILE_");
}

/**
 * Inherited Claude Code variables that change how a run behaves, taken from the
 * behavior-affecting entries of Claude Code's environment-variable reference: effort and
 * thinking, subagent model and limits, turn and output caps, context and compaction,
 * Bash/MCP output limits and timeouts, retries, tool search, and extra CLAUDE.md
 * directories. They are dropped from the launch environment so an operator's shell
 * cannot skew results. This is a denylist on purpose: `CLAUDE_CODE_*` also carries auth,
 * provider, proxy, and host plumbing, which must pass through for sign-in to work.
 * Model-selection `ANTHROPIC_*` variables are kept (Bedrock/Vertex need them); the
 * observed model is recorded in every result.
 */
export const RUN_SHAPING_CLAUDE_VARIABLES: ReadonlySet<string> = new Set([
  // Effort and thinking
  "CLAUDE_CODE_EFFORT_LEVEL",
  "CLAUDE_EFFORT",
  "CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
  "CLAUDE_CODE_DISABLE_THINKING",
  "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
  "DISABLE_INTERLEAVED_THINKING",
  "MAX_THINKING_TOKENS",
  "CLAUDE_CODE_DISABLE_FAST_MODE",
  "CLAUDE_CODE_DISABLE_ADVISOR_TOOL",
  // Turns, output, and context
  "CLAUDE_CODE_MAX_TURNS",
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_FILE_READ_MAX_OUTPUT_TOKENS",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_DISABLE_1M_CONTEXT",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
  "CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS",
  "DISABLE_AUTO_COMPACT",
  "DISABLE_COMPACT",
  // Subagents and tools
  "CLAUDE_CODE_SUBAGENT_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL_FORCE",
  "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
  "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
  "CLAUDE_CODE_FORK_SUBAGENT",
  "CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS",
  "CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS",
  "CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY",
  "CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION",
  "ENABLE_TOOL_SEARCH",
  "SLASH_COMMAND_TOOL_CHAR_BUDGET",
  "BASH_MAX_OUTPUT_LENGTH",
  "BASH_DEFAULT_TIMEOUT_MS",
  "BASH_MAX_TIMEOUT_MS",
  "CLAUDE_CODE_GLOB_TIMEOUT_SECONDS",
  // Shell tools: this opt-in keeps PowerShell enabled alongside the Bash deny.
  "CLAUDE_CODE_USE_POWERSHELL_TOOL",
  // Wraps every stdio MCP server's startup command, so a logger or audit wrapper could
  // delay or alter the measured server's launch.
  "CLAUDE_CODE_SHELL_PREFIX",
  // MCP (the allowlist toggle would hide PATH, and with it the adb the run was
  // fingerprinted against, from the measured server)
  "CLAUDE_CODE_MCP_ALLOWLIST_ENV",
  "ENABLE_CLAUDEAI_MCP_SERVERS",
  "MAX_MCP_OUTPUT_TOKENS",
  "MCP_CONNECTION_NONBLOCKING",
  "MCP_CONNECT_TIMEOUT_MS",
  "MCP_TIMEOUT",
  "MCP_TOOL_TIMEOUT",
  "CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT",
  "CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS",
  "CLAUDE_CODE_MCP_STARTUP_WAIT_MS",
  "CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH",
  // Request bodies (JSON merged into every API request)
  "CLAUDE_CODE_EXTRA_BODY",
  // Background tasks (force-enabling them backgrounds long MCP calls)
  "CLAUDE_AUTO_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  // Retries and API request timeouts
  "API_TIMEOUT_MS",
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_RETRY_WATCHDOG",
  // Mid-stream failures go to the retry layer instead of the non-streaming fallback
  "CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK",
  // The AWS SDK's retry policy for Bedrock (AWS_MAX_ATTEMPTS=1 disables retries)
  "AWS_RETRY_MODE",
  "AWS_MAX_ATTEMPTS",
  // System prompt and tool set (the attribution toggle changes the system prompt's opening)
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_CODE_SIMPLE_SYSTEM_PROMPT",
  "CLAUDE_CODE_ENABLE_TASKS",
  // Extra context sources
  "CLAUDE_ADDITIONAL_DIRECTORIES",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
]);

/**
 * Run-shaping families matched by prefix: prompt caching switches (global, per model, and
 * per provider, e.g. `DISABLE_PROMPT_CACHING_OPUS`, `ENABLE_PROMPT_CACHING_1H_BEDROCK`),
 * which change cost and latency.
 */
const RUN_SHAPING_CLAUDE_PREFIXES = [
  "DISABLE_PROMPT_CACHING",
  "ENABLE_PROMPT_CACHING",
  "FORCE_PROMPT_CACHING",
];

/**
 * Any Claude, API, MCP, or Bash timeout or watchdog override (API_TIMEOUT_MS,
 * API_FORCE_IDLE_TIMEOUT, CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS,
 * CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS, ...): each changes when a request or agent gives up,
 * so the family is scrubbed by name rather than one variable at a time.
 */
const RUN_SHAPING_TIMEOUT = /^(?:CLAUDE_|API_|MCP_|BASH_)\w*TIMEOUT(?:_MS|_SECONDS)?$/;
/**
 * Streaming watchdog toggles (CLAUDE_ENABLE_STREAM_WATCHDOG, CLAUDE_ENABLE_BYTE_WATCHDOG,
 * CLAUDE_ENABLE_BYTE_WATCHDOG_BEDROCK, ...): they turn the deadlines above on or off.
 */
const RUN_SHAPING_WATCHDOG = /^CLAUDE_\w*WATCHDOG\w*$/;
/**
 * API beta controls (ANTHROPIC_BETAS, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, ...): they add or
 * remove beta request headers and tool-schema fields.
 */
const RUN_SHAPING_BETAS = /^(?:ANTHROPIC|CLAUDE_CODE)_\w*BETAS$/;

export function isRunShapingClaudeVariable(key: string): boolean {
  return (
    RUN_SHAPING_CLAUDE_VARIABLES.has(key) ||
    RUN_SHAPING_TIMEOUT.test(key) ||
    RUN_SHAPING_WATCHDOG.test(key) ||
    RUN_SHAPING_BETAS.test(key) ||
    RUN_SHAPING_CLAUDE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/**
 * Windows environment names are case-insensitive, so `node_env` reaches a child as NODE_ENV;
 * keys are classified in their canonical (upper) case there.
 */
function canonicalKey(key: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? key.toUpperCase() : key;
}

/** The environment with keys in canonical case; on Windows a later duplicate wins, as there. */
function canonicalEnv(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): Record<string, string | undefined> {
  return platform === "win32"
    ? Object.fromEntries(
        Object.entries(env).map(([key, value]) => [canonicalKey(key, platform), value]),
      )
    : env;
}

/**
 * File and directory paths read from the environment: the provider SDKs' credential and
 * config files, the Android SDK roots, and the shared claim root the server also receives.
 */
const PATH_VARIABLES = new Set([
  "GOOGLE_APPLICATION_CREDENTIALS",
  "AWS_CONFIG_FILE",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  // Claude's own config directory and mTLS client certificate and key.
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_CLIENT_CERT",
  "CLAUDE_CODE_CLIENT_KEY",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  ...SHARED_AUTOMOBILE_VARIABLES,
]);

/**
 * Claude and the MCP server run from an empty temp directory, so a relative PATH entry,
 * credentials path, or SDK root that resolved from the invocation directory (as preflight's
 * did) would resolve somewhere else (or nowhere) there. They are made absolute against the
 * invocation directory first.
 */
function absolutizeInheritedPaths(
  env: Record<string, string>,
  cwd: string,
  platform: NodeJS.Platform,
): Record<string, string> {
  const path = platform === "win32" ? win32 : posix;
  const absolute = (entry: string) => path.resolve(cwd, entry);
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => {
      const canonical = canonicalKey(key, platform);
      if (canonical === "PATH") {
        // An empty POSIX entry means the current directory, which is also relative.
        return [key, value.split(path.delimiter).map(absolute).join(path.delimiter)];
      }
      if (PATH_VARIABLES.has(canonical) && value !== "") {
        return [key, absolute(value)];
      }
      return [key, value];
    }),
  );
}

/** The launch environment for Claude: isolated server env without run-shaping Claude overrides. */
export function claudeLaunchEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
): Record<string, string> {
  const kept = Object.fromEntries(
    Object.entries(isolatedServerEnv(inherited, paths, platform)).filter(
      ([key]) => !isRunShapingClaudeVariable(canonicalKey(key, platform)),
    ),
  );
  return absolutizeInheritedPaths(kept, cwd, platform);
}

/**
 * The inherited environment with every AutoMobile variable removed except the
 * shared ADB coordination directory, and without NODE_ENV, then the run's private-daemon
 * values on top, so each run starts from a clean AutoMobile configuration.
 */
export function isolatedServerEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const keep = (key: string) => {
    const canonical = canonicalKey(key, platform);
    // NODE_ENV=test (an operator's shell or a bun test parent) arms the server's test-only
    // guards and changes its behavior, so the run never inherits it.
    return (
      canonical !== "NODE_ENV" &&
      (SHARED_AUTOMOBILE_VARIABLES.has(canonical) || !isAutoMobileVariable(canonical))
    );
  };
  const base = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && keep(entry[0]),
    ),
  );
  return { ...base, ...privateServerEnv(paths) };
}

/**
 * Inherited variables the MCP server's explicit `env` repeats, so the private daemon reaches
 * the same adb server and claims devices under the same root that preflight and the ownership
 * check used. `CLAUDE_CODE_MCP_ALLOWLIST_ENV` is scrubbed from Claude's environment, so the
 * server also inherits the rest of it (PATH included); the block is defense in depth.
 */
const MCP_PASSTHROUGH_VARIABLES = [
  ...SHARED_AUTOMOBILE_VARIABLES,
  "ADB_SERVER_SOCKET",
  "ANDROID_ADB_SERVER_ADDRESS",
  "ANDROID_ADB_SERVER_PORT",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
];

/** The MCP server's explicit `env`: the passthrough variables plus the private daemon's. */
export function mcpServerEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
  switches: ServerSwitches = {},
): Record<string, string> {
  const shared = Object.fromEntries(
    MCP_PASSTHROUGH_VARIABLES.flatMap((key) => {
      const value = inherited[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return {
    ...absolutizeInheritedPaths(shared, cwd, platform),
    ...privateServerEnv(paths),
    ...serverSwitchEnv(switches),
  };
}

export function buildMcpConfig(
  paths: ServerPaths,
  inherited: Record<string, string | undefined> = {},
  platform: NodeJS.Platform = process.platform,
  cwd: string = process.cwd(),
  switches: ServerSwitches = {},
): Record<string, unknown> {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: paths.runtime,
        args: [paths.serverEntry],
        env: mcpServerEnv(inherited, paths, platform, cwd, switches),
      },
    },
  };
}

export interface PlaceholderValues {
  deviceSerial: string;
  packageName: string;
  runDirectory: string;
}

/** Replace `{deviceSerial}`, `{packageName}`, and `{runDirectory}` in suite text. */
export function fillPlaceholders(text: string, values: PlaceholderValues): string {
  return text
    .replaceAll("{deviceSerial}", values.deviceSerial)
    .replaceAll("{packageName}", values.packageName)
    .replaceAll("{runDirectory}", values.runDirectory);
}

/** The harness always tells the agent which device to use; suites may append more. */
export function systemPromptFor(suite: SuiteDefinition, values: PlaceholderValues): string {
  const base =
    `Use only the Android device with serial ${values.deviceSerial}. ` +
    `The app under test is ${values.packageName}. ` +
    "Interact with the device only through the auto-mobile MCP tools.";
  const extra = suite.claude.appendSystemPrompt?.trim();
  return extra ? `${base}\n\n${fillPlaceholders(extra, values)}` : base;
}

export function buildClaudeArgs(
  suite: SuiteDefinition,
  mcpConfigPath: string,
  systemPrompt: string,
  modelOverride?: string,
): string[] {
  const { claude } = suite;
  const model = modelOverride ?? claude.model;
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--mcp-config",
    mcpConfigPath,
    "--strict-mcp-config",
    // Skip user settings: their hooks and enabled plugins would alter runs per operator.
    // (--bare would too, but it forces API-key auth and breaks subscription sign-in.)
    "--setting-sources",
    "project,local",
    "--append-system-prompt",
    systemPrompt,
  ];
  if (model) {
    args.push("--model", model);
  }
  if (claude.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(claude.maxBudgetUsd));
  }
  if (claude.allowedTools.length > 0) {
    args.push("--allowedTools", ...claude.allowedTools);
  }
  if (claude.disallowedTools.length > 0) {
    args.push("--disallowedTools", ...claude.disallowedTools);
  }
  return args;
}

const PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
];
// Every provider's endpoint override (ANTHROPIC_BASE_URL, ANTHROPIC_BEDROCK_BASE_URL,
// ANTHROPIC_FOUNDRY_BASE_URL, ANTHROPIC_AWS_BASE_URL, ANTHROPIC_BEDROCK_MANTLE_BASE_URL, ...),
// and the AWS SDK's own (AWS_ENDPOINT_URL, AWS_ENDPOINT_URL_BEDROCK_RUNTIME, ...).
const PROVIDER_URL = /^ANTHROPIC_(?:\w+_)?BASE_URL$|^AWS_ENDPOINT_URL(?:_\w+)?$/;
const PROVIDER_REGIONS = [
  "AWS_REGION",
  "CLOUD_ML_REGION",
  // Turns the AWS endpoint overrides above (and config-file ones) off.
  "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
];
// Provider-specific region routing (ANTHROPIC_BEDROCK_REGION_PREFIX,
// ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION, VERTEX_REGION_CLAUDE_*, ...).
const PROVIDER_REGION = /^(?:ANTHROPIC_\w*REGION\w*|VERTEX_REGION_\w+)$/;
// Provider service tiers (ANTHROPIC_BEDROCK_SERVICE_TIER: default, flex, priority).
const PROVIDER_TIER = /^ANTHROPIC_\w*SERVICE_TIER$/;
// Provider resource selectors (ANTHROPIC_FOUNDRY_RESOURCE): a resource name, not a secret.
const PROVIDER_RESOURCE = /^ANTHROPIC_\w*RESOURCE$/;
// Proxy routing passes through too (Claude may need it to reach the API at all), and a
// different proxy changes latency. Upper- and lowercase forms are both honored.
const PROXY_URLS = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  // Claude-only proxy overrides, which Claude Code honors over the standard names.
  "CLAUDE_CODE_HTTPS_PROXY",
  "CLAUDE_CODE_HTTP_PROXY",
];
// Account and project selectors the provider SDKs read (the Vertex project, the Google Cloud
// project, the AWS profile Bedrock's credential chain uses): accounts differ in quota and
// provisioned capacity. Digested, since each names an account; secrets are never read.
const PROVIDER_ACCOUNTS = [
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  // The role the AWS credential chain assumes; its ARN names the target account.
  "AWS_ROLE_ARN",
  // The Anthropic-on-AWS workspace, sent on every request, and the workspace workload
  // identity federation exchanges tokens for; workspaces differ in quota.
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_WORKSPACE_ID",
  // Environment credentials outrank every profile, and the access key ID names the principal
  // (it is an identifier, not the secret key).
  "AWS_ACCESS_KEY_ID",
  // Extra request headers (tenant or gateway-routing values), digested since they may carry
  // a token.
  "ANTHROPIC_CUSTOM_HEADERS",
];
const PROXY_BYPASS = ["NO_PROXY", "no_proxy"];
// The adb server the measured MCP server reaches (MCP_PASSTHROUGH_VARIABLES): a remote adb
// route changes every device call's latency. These name a socket or host and port, no secret.
const ADB_ENDPOINT = ["ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_ADDRESS", "ANDROID_ADB_SERVER_PORT"];

/**
 * A non-secret identity of the backend Claude will use: which provider is selected, the
 * host and a digest of the path (never the credentials, which are digested, the path itself, or the query) of any
 * provider base URL or proxy, digests of the account and project selectors, the proxy bypass list, regions
 * and service tiers, the adb server endpoint,
 * and model-routing variables. Provider settings pass through to Claude on purpose, so they are recorded
 * rather than scrubbed: the same model through another backend can differ in latency.
 */
/**
 * The account a Google credentials file selects. Its project overrides the explicit project
 * variables, so a different file can mean a different backend. Only the non-secret identity
 * fields are read and they are digested; key material never leaves the file.
 */
export function googleCredentialsIdentity(
  path: string,
  readFile: (path: string) => string = (file) => readFileSync(file, "utf8"),
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(path));
  } catch (error) {
    // Unreadable is still an identity: it differs from any readable file's digest.
    return `unreadable:${error instanceof SyntaxError ? "json" : "file"}`;
  }
  const record =
    typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  // service_account_impersonation_url names the account an external_account file mints
  // tokens for, so two files with the same audience can still act as different accounts.
  const fields = [
    "type",
    "project_id",
    "quota_project_id",
    "client_email",
    "client_id",
    "audience",
    "service_account_impersonation_url",
  ];
  const identity = Object.fromEntries(fields.map((key) => [key, record[key] ?? null]));
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 12)}`;
}

/**
 * The AWS config file the Bedrock credential chain reads (AWS_CONFIG_FILE, else
 * ~/.aws/config). A profile name alone can map to a different account, role, region, or
 * endpoint on another host or after an edit, so the file's contents are digested. It holds
 * profile settings, not keys (those live in the credentials file, which is never read).
 */
export function awsConfigIdentity(
  path: string,
  readFile: (path: string) => string = (file) => readFileSync(file, "utf8"),
): string {
  try {
    return `sha256:${createHash("sha256").update(readFile(path)).digest("hex").slice(0, 12)}`;
  } catch {
    // No config file is a valid setup (environment or SSO-cache credentials); unreadable is
    // still an identity, distinct from any file's digest.
    return "unreadable";
  }
}

// Direct-API credentials; recorded by name only.
const DIRECT_CREDENTIALS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"];

// Providers that authenticate through the AWS credential chain.
const AWS_PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
];

/**
 * Managed settings files, which apply at the highest precedence whatever
 * `--setting-sources` says (hooks, env, permissions). Each existing file is digested, so a
 * differently managed host changes the build. Server-delivered and MDM-profile settings are
 * not visible as files and are not covered.
 */
export const MANAGED_SETTINGS_DIRS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/Library/Application Support/ClaudeCode"],
  linux: ["/etc/claude-code"],
  win32: ["C:\\Program Files\\ClaudeCode", "C:\\ProgramData\\ClaudeCode"],
};

export function managedSettingsIdentity(
  platform: NodeJS.Platform = process.platform,
  listFiles: (dir: string) => string[] = managedFilesIn,
  readFile: (path: string) => string = (file) => readFileSync(file, "utf8"),
): string {
  const path = platform === "win32" ? win32 : posix;
  return (MANAGED_SETTINGS_DIRS[platform] ?? [])
    .flatMap((dir) => listFiles(dir).map((file) => path.join(dir, file)))
    .sort()
    .map((file) => {
      try {
        return `${file}=sha256:${createHash("sha256").update(readFile(file)).digest("hex").slice(0, 12)}`;
      } catch {
        // Present but unreadable is still an identity, distinct from any readable digest.
        return `${file}=unreadable`;
      }
    })
    .join("\n");
}

/** managed-settings.json, managed-mcp.json, and managed-settings.d/*.json under one dir. */
function managedFilesIn(dir: string): string[] {
  const top = ["managed-settings.json", "managed-mcp.json"].filter((file) =>
    existsSync(join(dir, file)),
  );
  const dropIns = existsSync(join(dir, "managed-settings.d"))
    ? readdirSync(join(dir, "managed-settings.d"))
        .filter((file) => file.endsWith(".json"))
        .map((file) => join("managed-settings.d", file))
    : [];
  return [...top, ...dropIns];
}

export function providerIdentity(
  inherited: Record<string, string | undefined>,
  credentialsIdentity: (path: string) => string = googleCredentialsIdentity,
  platform: NodeJS.Platform = process.platform,
  awsConfig: (path: string) => string = awsConfigIdentity,
  home: string = homedir(),
): string {
  // Windows names are case-insensitive (anthropic_base_url is ANTHROPIC_BASE_URL there), so
  // every key is matched in canonical case.
  const env = canonicalEnv(inherited, platform);
  const host = (value: string) => {
    try {
      const url = new URL(value);
      // A gateway can route different paths on one host to different backends, so the path
      // counts too. It is digested, never echoed, in case it carries a key.
      const path = url.pathname.replace(/\/+$/, "");
      // The scheme counts as well: http and https to one gateway are different transports.
      // Proxy credentials can select a tenant with its own routing, so they count too,
      // digested and never echoed.
      const userinfo =
        url.username === "" && url.password === ""
          ? ""
          : `sha256:${createHash("sha256").update(`${url.username}:${url.password}`).digest("hex").slice(0, 12)}@`;
      const origin = `${url.protocol}//${userinfo}${url.host}`;
      return path === ""
        ? origin
        : `${origin}/sha256:${createHash("sha256").update(path).digest("hex").slice(0, 12)}`;
    } catch {
      // Not a URL: record that it was set, without echoing the value.
      return "(unparseable)";
    }
  };
  const set = (key: string) => env[key] !== undefined && env[key] !== "";
  const urls = Object.keys(env).filter((key) => PROVIDER_URL.test(key));
  const regions = Object.keys(env).filter(
    (key) => PROVIDER_REGION.test(key) || PROVIDER_TIER.test(key) || PROVIDER_RESOURCE.test(key),
  );
  const routing = Object.keys(env)
    .filter((key) => /^ANTHROPIC_(?:DEFAULT_\w+_)?MODEL$|^ANTHROPIC_SMALL_FAST_MODEL$/.test(key))
    .filter(set);
  return [
    ...PROVIDER_FLAGS.filter(set).map((key) => `${key}=${env[key]}`),
    ...[...urls, ...PROXY_URLS].filter(set).map((key) => `${key}=${host(env[key] as string)}`),
    ...PROVIDER_ACCOUNTS.filter(set).map(
      (key) =>
        `${key}=sha256:${createHash("sha256")
          .update(env[key] as string)
          .digest("hex")
          .slice(0, 12)}`,
    ),
    // Which credential kind authenticates (an API key overrides a subscription login under -p);
    // names only, since the only account identity in a key is the secret itself.
    ...DIRECT_CREDENTIALS.filter(set).map((key) => `auth=${key}`),
    ...(set("GOOGLE_APPLICATION_CREDENTIALS")
      ? [
          `GOOGLE_APPLICATION_CREDENTIALS=${credentialsIdentity(
            env.GOOGLE_APPLICATION_CREDENTIALS as string,
          )}`,
        ]
      : []),
    ...(AWS_PROVIDER_FLAGS.some(set)
      ? [
          `aws-config=${awsConfig(
            set("AWS_CONFIG_FILE") ? (env.AWS_CONFIG_FILE as string) : join(home, ".aws", "config"),
          )}`,
        ]
      : []),
    ...[...PROVIDER_REGIONS, ...regions, ...PROXY_BYPASS, ...ADB_ENDPOINT, ...routing]
      .filter(set)
      .map((key) => `${key}=${env[key]}`),
  ]
    .sort()
    .join("\n");
}
