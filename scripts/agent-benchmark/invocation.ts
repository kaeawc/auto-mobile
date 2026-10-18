/**
 * Build the per-run MCP config and the `claude -p` argument vector.
 *
 * Isolation contract (mirrors what the run must not inherit):
 * - `--strict-mcp-config` with a generated config, so user/project MCP servers
 *   never join the run.
 * - Claude runs from an empty temp directory outside the repository: Claude Code
 *   loads CLAUDE.md from the cwd and every ancestor, so a cwd under the checkout
 *   (even the artifact directory) would still pick up this repository's context.
 *   CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 is forced as well, so the operator's user-level
 *   ~/.claude/CLAUDE.md and auto-memory never shape a run, and
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
 * API beta controls (ANTHROPIC_BETAS, CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS, ...): they add or
 * remove beta request headers and tool-schema fields.
 */
const RUN_SHAPING_BETAS = /^(?:ANTHROPIC|CLAUDE_CODE)_\w*BETAS$/;

export function isRunShapingClaudeVariable(key: string): boolean {
  return (
    RUN_SHAPING_CLAUDE_VARIABLES.has(key) ||
    RUN_SHAPING_TIMEOUT.test(key) ||
    RUN_SHAPING_BETAS.test(key) ||
    RUN_SHAPING_CLAUDE_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** The launch environment for Claude: isolated server env without run-shaping Claude overrides. */
export function claudeLaunchEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(isolatedServerEnv(inherited, paths)).filter(
      ([key]) => !isRunShapingClaudeVariable(key),
    ),
  );
}

/**
 * The inherited environment with every AutoMobile variable removed except the
 * shared ADB coordination directory, and without NODE_ENV, then the run's private-daemon
 * values on top, so each run starts from a clean AutoMobile configuration.
 */
export function isolatedServerEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        // NODE_ENV=test (an operator's shell or a bun test parent) arms the server's
        // test-only guards and changes its behavior, so the run never inherits it.
        entry[0] !== "NODE_ENV" &&
        (SHARED_AUTOMOBILE_VARIABLES.has(entry[0]) || !isAutoMobileVariable(entry[0])),
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
): Record<string, string> {
  const shared = Object.fromEntries(
    MCP_PASSTHROUGH_VARIABLES.flatMap((key) => {
      const value = inherited[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
  return { ...shared, ...privateServerEnv(paths) };
}

export function buildMcpConfig(
  paths: ServerPaths,
  inherited: Record<string, string | undefined> = {},
): Record<string, unknown> {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: paths.runtime,
        args: [paths.serverEntry],
        env: mcpServerEnv(inherited, paths),
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
// ANTHROPIC_FOUNDRY_BASE_URL, ANTHROPIC_AWS_BASE_URL, ANTHROPIC_BEDROCK_MANTLE_BASE_URL, ...).
const PROVIDER_URL = /^ANTHROPIC_(?:\w+_)?BASE_URL$/;
const PROVIDER_REGIONS = ["AWS_REGION", "CLOUD_ML_REGION"];
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
// The Google Cloud project Vertex bills and routes through: projects differ in quota and
// provisioned capacity. Digested, since a project ID names an account.
const PROVIDER_PROJECTS = ["ANTHROPIC_VERTEX_PROJECT_ID"];
const PROXY_BYPASS = ["NO_PROXY", "no_proxy"];
// The adb server the measured MCP server reaches (MCP_PASSTHROUGH_VARIABLES): a remote adb
// route changes every device call's latency. These name a socket or host and port, no secret.
const ADB_ENDPOINT = ["ADB_SERVER_SOCKET", "ANDROID_ADB_SERVER_ADDRESS", "ANDROID_ADB_SERVER_PORT"];

/**
 * A non-secret identity of the backend Claude will use: which provider is selected, the
 * host and a digest of the path (never credentials, the path itself, or the query) of any
 * provider base URL or proxy, a digest of the Vertex project, the proxy bypass list, regions
 * and service tiers, the adb server endpoint,
 * and model-routing variables. Provider settings pass through to Claude on purpose, so they are recorded
 * rather than scrubbed: the same model through another backend can differ in latency.
 */
export function providerIdentity(env: Record<string, string | undefined>): string {
  const host = (value: string) => {
    try {
      const url = new URL(value);
      // A gateway can route different paths on one host to different backends, so the path
      // counts too. It is digested, never echoed, in case it carries a key.
      const path = url.pathname.replace(/\/+$/, "");
      // The scheme counts as well: http and https to one gateway are different transports.
      const origin = `${url.protocol}//${url.host}`;
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
    ...PROVIDER_PROJECTS.filter(set).map(
      (key) =>
        `${key}=sha256:${createHash("sha256")
          .update(env[key] as string)
          .digest("hex")
          .slice(0, 12)}`,
    ),
    ...[...PROVIDER_REGIONS, ...regions, ...PROXY_BYPASS, ...ADB_ENDPOINT, ...routing]
      .filter(set)
      .map((key) => `${key}=${env[key]}`),
  ]
    .sort()
    .join("\n");
}
