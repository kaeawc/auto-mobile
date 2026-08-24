import type { FeatureFlagKey } from "../features/featureFlags/FeatureFlagDefinitions";

/**
 * Config plumbing for the MCP output-context reduction effort (issue #2756).
 *
 * Each flag parses from a CLI flag OR an `AUTOMOBILE_*` env var. The CLI flag
 * wins via `||`: if it is present the flag is enabled regardless of the env var.
 * All flags default off. Env vars enable only on the exact string `"1"`.
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
}

export type OutputReductionFlagField = keyof OutputReductionFlags;

export interface OutputReductionFlagSpec {
  /** The `OutputReductionFlags` field this spec resolves. */
  field: OutputReductionFlagField;
  /** The CLI flag, e.g. `--observe-result-compact`. */
  cli: string;
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
];

/**
 * Resolve all output-reduction flags from CLI args and the process environment.
 * CLI takes precedence over env (`||`); env enables only on `"1"`.
 */
export function parseOutputReductionFlags(
  args: string[],
  env: Record<string, string | undefined>,
): OutputReductionFlags {
  const resolve = (spec: OutputReductionFlagSpec): boolean =>
    args.includes(spec.cli) || env[spec.env] === "1";

  // Default every field off, then let each spec set its own field. Driving the
  // result off the spec list (rather than positional SPECS[0..4] access) means
  // reordering or extending the list can never silently mis-map a field.
  const flags: OutputReductionFlags = {
    observeResultIncludeElements: false,
    toolResultsNoStructuredContent: false,
    actionsDiffObserve: false,
    actionsNoObserve: false,
  };
  for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
    flags[spec.field] = resolve(spec);
  }
  return flags;
}

/**
 * Serialize the enabled output-reduction flags back to their CLI args for the
 * MCP-process -> daemon-process relay. This is the inverse of the daemon-side
 * parse in `parseDaemonArgs`; keeping both driven off the same specs (and
 * round-trip tested) prevents the two hand-written flag strings from drifting.
 */
export function outputReductionFlagsToArgs(flags: Partial<OutputReductionFlags>): string[] {
  const args: string[] = [];
  for (const spec of OUTPUT_REDUCTION_FLAG_SPECS) {
    if (flags[spec.field]) {
      args.push(spec.cli);
    }
  }
  return args;
}
