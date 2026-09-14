import type { DaemonOptions } from "./types";

export const REUSE_CRITICAL_ARRAY_OPTION_KEYS: readonly ("enabledTools" | "disabledTools")[] = [
  "enabledTools",
  "disabledTools",
];

function stringArrayOption(
  options: DaemonOptions | undefined,
  key: "enabledTools" | "disabledTools",
): readonly string[] | undefined {
  const value = options?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function applyExactToolSelections(
  assignments: Map<string, boolean>,
  options: DaemonOptions | undefined,
): void {
  for (const toolName of stringArrayOption(options, "enabledTools") ?? []) {
    assignments.set(toolName, true);
  }
  for (const toolName of stringArrayOption(options, "disabledTools") ?? []) {
    assignments.set(toolName, false);
  }
}

/**
 * Produces a conflict-free exact-tool selection set. Requested options are
 * applied after running options, so an explicit request wins for the same tool.
 */
export function mergedExactToolSelections(
  running: DaemonOptions | undefined,
  requested: DaemonOptions | undefined,
): Pick<DaemonOptions, "enabledTools" | "disabledTools"> | undefined {
  const selectionsSpecified = REUSE_CRITICAL_ARRAY_OPTION_KEYS.some(
    (key) =>
      stringArrayOption(running, key) !== undefined ||
      stringArrayOption(requested, key) !== undefined,
  );
  if (!selectionsSpecified) {
    return undefined;
  }
  const assignments = new Map<string, boolean>();
  applyExactToolSelections(assignments, running);
  applyExactToolSelections(assignments, requested);
  return {
    enabledTools: Array.from(assignments)
      .filter(([, enabled]) => enabled)
      .map(([toolName]) => toolName),
    disabledTools: Array.from(assignments)
      .filter(([, enabled]) => !enabled)
      .map(([toolName]) => toolName),
  };
}
