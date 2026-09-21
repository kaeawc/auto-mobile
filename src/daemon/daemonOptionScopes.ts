import type { DaemonOptions } from "./types";

/** Options whose meaning belongs to one MCP connection, never the daemon process. */
export const CONNECTION_PRESENTATION_OPTION_KEYS = [
  "enabledTools",
  "disabledTools",
  "toolResultsNoStructuredContent",
] as const satisfies readonly (keyof DaemonOptions)[];

/** Environment equivalents that belong to the spawning MCP connection, not its child daemon. */
export const CONNECTION_PRESENTATION_ENV_KEYS = [
  "AUTOMOBILE_ENABLED_TOOLS",
  "AUTOMOBILE_DISABLED_TOOLS",
  "AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT",
] as const;

/** Remove connection presentation fields before a daemon lifecycle action. */
export function daemonProcessOptions(options: DaemonOptions | undefined): DaemonOptions {
  const processOptions: DaemonOptions = { ...(options ?? {}) };
  for (const key of CONNECTION_PRESENTATION_OPTION_KEYS) {
    delete processOptions[key];
  }
  return processOptions;
}

/** Keep connection tool flags out of daemon-wide startup defaults. */
export function toolSelectionStartupOptions(
  daemonMode: boolean,
  enabledTools: readonly string[],
  disabledTools: readonly string[],
): Required<Pick<DaemonOptions, "enabledTools" | "disabledTools">> {
  if (daemonMode) {
    return { enabledTools: [], disabledTools: [] };
  }
  return {
    enabledTools: [...enabledTools],
    disabledTools: [...disabledTools],
  };
}

/** Prevent a spawned daemon from re-importing connection presentation through inherited env. */
export function daemonProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const processEnvironment = { ...environment };
  for (const key of CONNECTION_PRESENTATION_ENV_KEYS) {
    delete processEnvironment[key];
  }
  return processEnvironment;
}
