import { type DaemonOptions } from "../types";
import { OUTPUT_REDUCTION_FLAG_SPECS } from "../../utils/outputReductionFlags";
import { daemonReuseOptions } from "../daemonOptionScopes";

/**
 * The daemon startup options that change its observable MCP behavior and so must
 * match before a running daemon can be reused: `debug`, `embeddedSdk`, `networkMockable`,
 * every process-global feature-flag CLI override, marker-based eventAll promotion config,
 * plus every process-global output-reduction flag. A
 * same-build MCP client that requests one of these against an already-running
 * daemon started without it (or vice versa) would otherwise silently get the
 * wrong tool-output or text-input behavior until a manual restart. `debug`, `embeddedSdk`,
 * and `networkMockable`
 * additionally gate whole tool families out of the registry, so reusing a daemon
 * that lacks the requested flag makes those tools unreachable (issue #4247). The
 * output-reduction fields are derived from `OUTPUT_REDUCTION_FLAG_SPECS` (whose
 * `field` names map 1:1 to `DaemonOptions`) so a new flag is covered
 * automatically.
 */
export const REUSE_CRITICAL_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "debug",
  "debugPerf",
  "embeddedSdk",
  "networkMockable",
  "noUiPerfMode",
  "memPerfAudit",
  "accessibilityAudit",
  "predictiveUi",
  "rawElementSearch",
  "toolCallRecording",
  "noNavigationScreenshots",
  ...OUTPUT_REDUCTION_FLAG_SPECS.filter(
    (spec) =>
      spec.field !== "toolResultsNoStructuredContent" && spec.field !== "actionsCompactMetadata",
  ).map((spec) => spec.field),
];

const REUSE_CRITICAL_STRING_OPTION_KEYS: (keyof DaemonOptions)[] = [
  "toolOutputsDir",
  "accessibilityLevel",
  "accessibilityFailureMode",
  "accessibilityMinSeverity",
];

const REUSE_CRITICAL_NUMBER_OPTION_KEYS: (keyof DaemonOptions)[] = ["runnerReadinessTimeoutMs"];

/** Every startup option inspected by startupOptionDeficits(). */
export const STARTUP_OPTION_DEFICIT_KEYS: readonly (keyof DaemonOptions)[] = [
  ...REUSE_CRITICAL_OPTION_KEYS,
  ...REUSE_CRITICAL_STRING_OPTION_KEYS,
  ...REUSE_CRITICAL_NUMBER_OPTION_KEYS,
  "accessibilityUseBaseline",
  "eventAllMarkers",
];

/** The value of a startup option when it is a string, else undefined. */
function stringOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions,
): string | undefined {
  const value = options?.[key];
  return typeof value === "string" ? value : undefined;
}

function numberOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions,
): number | undefined {
  const value = options?.[key];
  return typeof value === "number" ? value : undefined;
}

function stringArrayOption(
  options: DaemonOptions | undefined,
  key: keyof DaemonOptions,
): readonly string[] | undefined {
  const value = options?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requestedOptionDeficits<T>(
  keys: readonly (keyof DaemonOptions)[],
  requested: DaemonOptions | undefined,
  running: DaemonOptions | undefined,
  readRequested: (options: DaemonOptions | undefined, key: keyof DaemonOptions) => T | undefined,
  readRunning: (options: DaemonOptions | undefined, key: keyof DaemonOptions) => T,
  equals: (requestedValue: T, runningValue: T) => boolean = (left, right) => left === right,
): string[] {
  return keys.flatMap((key) => {
    const requestedValue = readRequested(requested, key);
    if (requestedValue === undefined) {
      return [];
    }
    const runningValue = readRunning(running, key);
    return equals(requestedValue, runningValue)
      ? []
      : [
          `${key} (requested=${JSON.stringify(requestedValue)}, running=${JSON.stringify(runningValue)})`,
        ];
  });
}

/**
 * Reuse-critical startup options the connecting client *explicitly requests*
 * that the running daemon lacks. Reconciliation is **one-directional** (issue
 * #3846): a client that does not ask for a flag has no opinion on it, so a flag
 * the daemon already has is never reported as a deficit just because a
 * particular caller (e.g. a bare short-lived CLI client) didn't request it.
 * Booleans are compared strictly (`=== true`), so `undefined` and `false` both
 * read as "no opinion"; strings and marker arrays count only when the client
 * supplies one that differs from the daemon's. Connection presentation options
 * (including the compact-metadata opt-out, relayed per connection) are
 * intentionally absent from this comparison, so they never restart the shared
 * daemon.
 * Returns a human-readable list (empty when the daemon already satisfies every
 * requested flag) for logging and error messages.
 */
export function startupOptionDeficits(
  requested: DaemonOptions | undefined,
  running: DaemonOptions | undefined,
): string[] {
  return [
    ...requestedOptionDeficits(
      REUSE_CRITICAL_OPTION_KEYS,
      requested,
      running,
      (options, key) => (options?.[key] === true ? true : undefined),
      (options, key) => options?.[key] === true,
    ),
    ...requestedOptionDeficits(
      REUSE_CRITICAL_STRING_OPTION_KEYS,
      requested,
      running,
      stringOption,
      (options, key) => stringOption(options, key) ?? "unset",
    ),
    ...requestedOptionDeficits(
      REUSE_CRITICAL_NUMBER_OPTION_KEYS,
      requested,
      running,
      numberOption,
      (options, key) => numberOption(options, key) ?? Number.NaN,
    ),
    ...requestedOptionDeficits(
      ["accessibilityUseBaseline"],
      requested,
      running,
      (options) =>
        options?.accessibilityAudit === true
          ? options.accessibilityUseBaseline === true
          : undefined,
      (options) => options?.accessibilityUseBaseline === true,
    ),
    ...requestedOptionDeficits(
      ["eventAllMarkers"],
      requested,
      running,
      (options, key) => stringArrayOption(options, key),
      (options, key) => stringArrayOption(options, key) ?? [],
      arraysEqual,
    ),
  ];
}

/**
 * Options to launch a replacement daemon with when a restart is unavoidable
 * (version/build skew, or a genuine startup-option deficit). Preserves the
 * *running* daemon's existing options as the base and overlays the connecting
 * client's requested options, so a restart triggered for any reason can never
 * silently strip a flag the daemon was already launched with (issue #3846) —
 * it only ever adds flags the client explicitly asks for. Boolean CLI options
 * are one-directional: `false` means the caller has no opinion, so every
 * active boolean on the running daemon is force-preserved. Connection
 * presentation options are dropped: they are relayed per connection instead.
 */
export function mergeDaemonOptions(
  running: DaemonOptions | undefined,
  requested: DaemonOptions | undefined,
): DaemonOptions {
  const runningOptions = daemonReuseOptions(running);
  const requestedOptions = daemonReuseOptions(requested);
  const merged: DaemonOptions = { ...runningOptions, ...requestedOptions };
  const mergedRecord = merged as Record<string, unknown>;
  for (const [key, value] of Object.entries(runningOptions)) {
    if (value === true) {
      mergedRecord[key] = true;
    }
  }
  if (requested?.accessibilityAudit === true) {
    merged.accessibilityUseBaseline = requested.accessibilityUseBaseline === true;
  }
  for (const key of REUSE_CRITICAL_STRING_OPTION_KEYS) {
    const runningString = stringOption(running, key);
    if (stringOption(requested, key) === undefined && runningString !== undefined) {
      mergedRecord[key] = runningString;
    }
  }
  for (const key of REUSE_CRITICAL_NUMBER_OPTION_KEYS) {
    const runningNumber = numberOption(running, key);
    if (numberOption(requested, key) === undefined && runningNumber !== undefined) {
      mergedRecord[key] = runningNumber;
    }
  }
  return merged;
}
