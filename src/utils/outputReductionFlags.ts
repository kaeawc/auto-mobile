import type { FeatureFlagKey } from "../models/FeatureFlagDefinitions";

/**
 * Config plumbing for the MCP output-context reduction effort (issue #2756).
 *
 * Each flag parses from a CLI flag or an `AUTOMOBILE_*` env var. Positive CLI
 * flags take precedence over negative CLI flags and the environment.
 * Compact action metadata defaults on and accepts exact env "0" to opt out;
 * other flags default off and enable only on exact env "1".
 *
 * Historical note: compact bounds tuples, the skeleton projection, compact
 * (non-pretty) JSON, and the focus/overview/region observe-scope gates were once
 * opt-in flags here. They are now unconditional defaults, so their old flags
 * (`--observe-result-compact`, `--observe-result-project-skeleton`,
 * `--tool-results-compact-json`, `--observe-focus-scope`, `--observe-overview`,
 * `--observe-region`, and the matching `AUTOMOBILE_*` env vars) are silently
 * ignored — passing them is a harmless no-op, no error or migration warning.
 * `observe-result-drop-elements` inverted the same way: dropping the flattened
 * `elements` array is the default, and `--observe-result-include-elements`
 * (below) is the opt-in that restores it.
 */
export interface OutputReductionFlags {
  /**
   * Opt back in to the flattened `elements` array on observe results, which is
   * dropped by default. Inverse of the retired `--observe-result-drop-elements`.
   */
  observeResultIncludeElements: boolean;
  toolResultsNoStructuredContent: boolean;
  actionsDiffObserve: boolean;
  actionsNoObserve: boolean;
  actionsCompactMetadata: boolean;
}

export type OutputReductionFlagField = keyof OutputReductionFlags;

export interface OutputReductionFlagSpec {
  /** The `OutputReductionFlags` field this spec resolves. */
  field: OutputReductionFlagField;
  /** The CLI flag, e.g. `--observe-result-compact`. */
  cli: string;
  /** Default-on flags support an explicit negative arg for the daemon relay. */
  disableCli?: string;
  /** Defaults to false when absent. */
  defaultValue?: boolean;
  /** The env var, e.g. `AUTOMOBILE_OBSERVE_RESULT_COMPACT`. */
  env: string;
  /** The feature-flag pipeline key this flag routes through. */
  featureFlagKey: FeatureFlagKey;
  /** Human-readable label for startup logging. */
  label: string;
}

export const OUTPUT_REDUCTION_FLAG_SPECS: OutputReductionFlagSpec[] = [
  {
    field: "observeResultIncludeElements",
    cli: "--observe-result-include-elements",
    env: "AUTOMOBILE_OBSERVE_RESULT_INCLUDE_ELEMENTS",
    featureFlagKey: "observe-result-include-elements",
    label: "--observe-result-include-elements",
  },
  {
    field: "toolResultsNoStructuredContent",
    cli: "--tool-results-no-structured-content",
    env: "AUTOMOBILE_TOOL_RESULTS_NO_STRUCTURED_CONTENT",
    featureFlagKey: "tool-results-no-structured-content",
    label: "--tool-results-no-structured-content",
  },
  {
    field: "actionsDiffObserve",
    cli: "--actions-diff-observe",
    env: "AUTOMOBILE_ACTIONS_DIFF_OBSERVE",
    featureFlagKey: "actions-diff-observe",
    label: "--actions-diff-observe",
  },
  {
    field: "actionsNoObserve",
    cli: "--actions-no-observe",
    env: "AUTOMOBILE_ACTIONS_NO_OBSERVE",
    featureFlagKey: "actions-no-observe",
    label: "--actions-no-observe",
  },
  {
    field: "actionsCompactMetadata",
    cli: "--actions-compact-metadata",
    disableCli: "--no-actions-compact-metadata",
    defaultValue: true,
    env: "AUTOMOBILE_ACTIONS_COMPACT_METADATA",
    featureFlagKey: "actions-compact-metadata",
    label: "--actions-compact-metadata",
  },
];

/**
 * Resolve explicit overrides separately from defaults. Startup must not persist
 * the default-on value over a saved feature-flag false, or relay it as a request
 * to re-enable an already configured daemon.
 */
export function parseOutputReductionFlagOverrides(
  args: string[],
  env: Record<string, string | undefined>,
): Partial<OutputReductionFlags> {
  const overrides: Partial<OutputReductionFlags> = {};
  for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
    if (args.includes(spec.cli)) {
      overrides[spec.field] = true;
    } else if (spec.disableCli && args.includes(spec.disableCli)) {
      overrides[spec.field] = false;
    } else if (env[spec.env] === "1") {
      overrides[spec.field] = true;
    } else if (spec.defaultValue && env[spec.env] === "0") {
      overrides[spec.field] = false;
    }
  }
  return overrides;
}

/** Resolve flags with explicit CLI/env overrides taking precedence over defaults. */
export function parseOutputReductionFlags(
  args: string[],
  env: Record<string, string | undefined>,
): OutputReductionFlags {
  const overrides = parseOutputReductionFlagOverrides(args, env);
  const flags: OutputReductionFlags = {
    observeResultIncludeElements: false,
    toolResultsNoStructuredContent: false,
    actionsDiffObserve: false,
    actionsNoObserve: false,
    actionsCompactMetadata: true,
  };
  for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
    flags[spec.field] = overrides[spec.field] ?? spec.defaultValue ?? false;
  }
  return flags;
}

/**
 * Serialize explicit output-reduction values back to their CLI args for the
 * MCP-process -> daemon-process relay. This is the inverse of the daemon-side
 * parse in `parseDaemonArgs`; keeping both driven off the same specs (and
 * round-trip tested) prevents the two hand-written flag strings from drifting.
 */
export function outputReductionFlagsToArgs(flags: Partial<OutputReductionFlags>): string[] {
  const args: string[] = [];
  for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
    if (flags[spec.field] === true) {
      args.push(spec.cli);
    } else if (flags[spec.field] === false && spec.disableCli) {
      args.push(spec.disableCli);
    }
  }
  return args;
}
