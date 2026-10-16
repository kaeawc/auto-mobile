/**
 * Build the per-run MCP config and the `claude -p` argument vector.
 *
 * Isolation contract (mirrors what the run must not inherit):
 * - `--strict-mcp-config` with a generated config, so user/project MCP servers
 *   never join the run.
 * - Claude runs from the per-run artifact directory, so this repository's
 *   CLAUDE.md and skills are not discovered implicitly.
 * - The auto-mobile server talks to a private daemon (`AUTOMOBILE_AUX_SOCKET_DIR`)
 *   with a fresh database and its own log directory, so a resident daemon or a
 *   learned navigation graph from an earlier run cannot change the result. The
 *   ADB coordination directory is deliberately inherited: device claims must stay
 *   shared with any resident daemon.
 * - The prompt is passed on stdin, never as a positional argument, because the
 *   variadic `--allowedTools`/`--disallowedTools` flags would swallow it.
 */
import { MCP_SERVER_NAME, type SuiteDefinition } from "./config";

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

export function buildMcpConfig(paths: ServerPaths): Record<string, unknown> {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: paths.runtime,
        args: [paths.serverEntry],
        env: privateServerEnv(paths),
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
