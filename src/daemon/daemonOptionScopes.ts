import type { DaemonOptions } from "./types";
import { ENV } from "../config/env";

/**
 * Options scoped to one proxy connection when relayed to a spawned daemon.
 * An operator launching `--daemon-mode` directly may still use the same flags
 * to seed that daemon's shared startup policy.
 */
export const CONNECTION_PRESENTATION_OPTION_KEYS = [
  "enabledTools",
  "disabledTools",
  "toolResultsNoStructuredContent",
  "actionsCompactMetadata",
] as const satisfies readonly (keyof DaemonOptions)[];

const DAEMON_CHILD_EXCLUDED_OPTION_KEYS = [
  "toolResultsNoStructuredContent",
  "actionsCompactMetadata",
] as const satisfies readonly (keyof DaemonOptions)[];

/** Environment equivalents that belong to the spawning MCP connection, not its child daemon. */
export const CONNECTION_PRESENTATION_ENV_KEYS = [
  ENV.ENABLED_TOOLS.name,
  ENV.DISABLED_TOOLS.name,
  "AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT",
  "AUTOMOBILE_ACTIONS_COMPACT_METADATA",
] as const;

/** Remove presentation fields that can never become daemon-wide startup policy. */
export function daemonProcessOptions(options: DaemonOptions | undefined): DaemonOptions {
  const processOptions: DaemonOptions = { ...(options ?? {}) };
  for (const key of DAEMON_CHILD_EXCLUDED_OPTION_KEYS) {
    delete processOptions[key];
  }
  return processOptions;
}

/** Ignore per-connection tool choices when deciding whether a shared daemon must restart. */
export function daemonReuseOptions(options: DaemonOptions | undefined): DaemonOptions {
  const reuseOptions: DaemonOptions = { ...(options ?? {}) };
  for (const key of CONNECTION_PRESENTATION_OPTION_KEYS) {
    delete reuseOptions[key];
  }
  return reuseOptions;
}

/**
 * Bun exports this when it runs with `--no-orphans` (or bunfig `[run] noOrphans`). A Bun 1.4 process
 * that inherits it arms no-orphans mode itself: on Linux every child it spawns gets
 * `PR_SET_PDEATHSIG(SIGKILL)` and dies with it, and every descendant is killed on its clean exit.
 * The daemon owns long-lived emulators, simulators and native helpers whose lifetimes it manages
 * itself (orphan sweeps, startup reaping), so it must never inherit the mode from its launcher.
 */
export const BUN_NO_ORPHANS_ENV = "BUN_FEATURE_FLAG_NO_ORPHANS";

/**
 * Prevent a spawned daemon from re-importing connection presentation through inherited env, or
 * inheriting Bun's no-orphans mode from its launcher.
 */
export function daemonProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const processEnvironment = { ...environment };
  for (const key of [...CONNECTION_PRESENTATION_ENV_KEYS, BUN_NO_ORPHANS_ENV]) {
    delete processEnvironment[key];
  }
  return processEnvironment;
}
