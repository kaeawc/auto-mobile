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
  dbDir: string;
  logDir: string;
}

export function privateServerEnv(paths: ServerPaths): Record<string, string> {
  return {
    AUTOMOBILE_AUX_SOCKET_DIR: paths.auxSocketDir,
    AUTOMOBILE_HARNESS_PRIVATE_DAEMON: "1",
    AUTOMOBILE_PRIVATE_DAEMON_ORPHAN_IDLE_MS: PRIVATE_DAEMON_ORPHAN_IDLE_MS,
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
  // MCP
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
  // Retries
  "CLAUDE_CODE_MAX_RETRIES",
  "CLAUDE_CODE_RETRY_WATCHDOG",
  // Extra context sources
  "CLAUDE_ADDITIONAL_DIRECTORIES",
  "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD",
]);

/** The launch environment for Claude: isolated server env without run-shaping Claude overrides. */
export function claudeLaunchEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(isolatedServerEnv(inherited, paths)).filter(
      ([key]) => !RUN_SHAPING_CLAUDE_VARIABLES.has(key),
    ),
  );
}

/**
 * The inherited environment with every AutoMobile variable removed except the
 * shared ADB coordination directory, then the run's private-daemon values on top,
 * so each run starts from a clean AutoMobile configuration.
 */
export function isolatedServerEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
): Record<string, string> {
  const base = Object.fromEntries(
    Object.entries(inherited).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (SHARED_AUTOMOBILE_VARIABLES.has(entry[0]) || !isAutoMobileVariable(entry[0])),
    ),
  );
  return { ...base, ...privateServerEnv(paths) };
}

/**
 * The MCP server's explicit `env`. It repeats the shared claim root: with
 * `CLAUDE_CODE_MCP_ALLOWLIST_ENV=1`, Claude gives stdio servers only a safe default
 * environment plus this block, and the private daemon must claim devices under the same
 * root the harness checked.
 */
export function mcpServerEnv(
  inherited: Record<string, string | undefined>,
  paths: ServerPaths,
): Record<string, string> {
  const shared = Object.fromEntries(
    [...SHARED_AUTOMOBILE_VARIABLES].flatMap((key) => {
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
  return [...args, ...claude.extraArgs];
}
