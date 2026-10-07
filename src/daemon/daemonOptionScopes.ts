import type { DaemonOptions } from "./types";

/**
 * Options scoped to one proxy connection when relayed to a spawned daemon.
 * An operator launching `--daemon-mode` directly may still use the same flags
 * to seed that daemon's shared startup policy.
 */
export const CONNECTION_PRESENTATION_OPTION_KEYS = [
  "enabledTools",
  "disabledTools",
  "toolResultsNoStructuredContent",
] as const satisfies readonly (keyof DaemonOptions)[];

const DAEMON_CHILD_EXCLUDED_OPTION_KEYS = [
  "toolResultsNoStructuredContent",
] as const satisfies readonly (keyof DaemonOptions)[];

/** Environment equivalents that belong to the spawning MCP connection, not its child daemon. */
export const CONNECTION_PRESENTATION_ENV_KEYS = [
  "AUTOMOBILE_ENABLED_TOOLS",
  "AUTOMOBILE_DISABLED_TOOLS",
  "AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT",
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

/** Prevent a spawned daemon from re-importing connection presentation through inherited env. */
export function daemonProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const processEnvironment = { ...environment };
  for (const key of CONNECTION_PRESENTATION_ENV_KEYS) {
    delete processEnvironment[key];
  }
  return processEnvironment;
}
