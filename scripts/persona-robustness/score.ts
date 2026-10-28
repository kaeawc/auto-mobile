/**
 * Scoring for the persona robustness harness (#14061). Pure functions over `executePlan`
 * payloads, so the verdict rules are tested without a device.
 */

/**
 * - pass: the plan succeeded with no skipped optional steps and no step warnings.
 * - recovered: the plan succeeded, but only by skipping optional steps or with step warnings.
 * - failed: the plan failed; `failedStep` names the step.
 * - error: the harness could not apply the perturbation or read a plan result, so the replay
 *   says nothing about the app.
 */
export type ReplayOutcome = "pass" | "recovered" | "failed" | "error";

export interface FailedStepSummary {
  stepIndex: number;
  tool: string;
  error: string;
}

export interface ReplayScore {
  outcome: ReplayOutcome;
  failedStep?: FailedStepSummary;
  skippedSteps: number;
  warningSteps: number;
  /** Why the replay is an `error`. */
  error?: string;
}

/** Mixed outcomes across repeats of one perturbation are `flaky`, not a verdict on the persona. */
export type Verdict = ReplayOutcome | "flaky";

const ERROR_MESSAGE_LIMIT = 300;

function truncate(text: string): string {
  return text.length > ERROR_MESSAGE_LIMIT ? `${text.slice(0, ERROR_MESSAGE_LIMIT)}…` : text;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function readFailedStep(value: unknown): FailedStepSummary | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.stepIndex !== "number" || typeof record.tool !== "string") {
    return undefined;
  }
  return {
    stepIndex: record.stepIndex,
    tool: record.tool,
    error: truncate(typeof record.error === "string" ? record.error : ""),
  };
}

export function errorScore(error: string): ReplayScore {
  return { outcome: "error", skippedSteps: 0, warningSteps: 0, error: truncate(error) };
}

/** Score one `executePlan` payload. A payload with no boolean `success` is an `error`. */
export function scoreReplay(payload: Record<string, unknown> | undefined): ReplayScore {
  if (!payload || typeof payload.success !== "boolean") {
    return errorScore("executePlan returned no plan result");
  }
  const skippedSteps = arrayLength(payload.skippedSteps);
  const warningSteps = arrayLength(payload.warnings);
  if (!payload.success) {
    const failedStep = readFailedStep(payload.failedStep);
    return {
      outcome: "failed",
      skippedSteps,
      warningSteps,
      ...(failedStep ? { failedStep } : {}),
      ...(!failedStep && typeof payload.error === "string"
        ? { error: truncate(payload.error) }
        : {}),
    };
  }
  return {
    outcome: skippedSteps > 0 || warningSteps > 0 ? "recovered" : "pass",
    skippedSteps,
    warningSteps,
  };
}

export function isSuccess(verdict: Verdict): boolean {
  return verdict === "pass" || verdict === "recovered";
}

/**
 * Combine repeats: one outcome is the verdict; pass mixed with recovered is `recovered`; any
 * `error` is `error`; failed mixed with success is `flaky`.
 */
export function aggregateVerdict(runs: readonly ReplayScore[]): Verdict {
  const outcomes = new Set(runs.map((run) => run.outcome));
  if (outcomes.size === 0 || outcomes.has("error")) {
    return "error";
  }
  if (outcomes.size === 1) {
    return [...outcomes][0]!;
  }
  return outcomes.has("failed") ? "flaky" : "recovered";
}

export function countOutcomes(runs: readonly ReplayScore[]): Record<ReplayOutcome, number> {
  const counts: Record<ReplayOutcome, number> = { pass: 0, recovered: 0, failed: 0, error: 0 };
  for (const run of runs) {
    counts[run.outcome] += 1;
  }
  return counts;
}

/** The first failing step across repeats, used as the perturbation's representative failure. */
export function firstFailedStep(runs: readonly ReplayScore[]): FailedStepSummary | undefined {
  return runs.find((run) => run.failedStep)?.failedStep;
}

/**
 * Why a perturbation did not pass cleanly:
 * - none: it passed or recovered.
 * - not-attributable: the baseline did not succeed, or a replay hit a harness error.
 * - perturbation: a single-facet perturbation (display stressor or facet ablation) broke the plan.
 * - facets: these facets of a persona break the plan on their own.
 * - interaction: the persona fails, but no facet fails alone.
 * - not-ablated: the persona fails and ablation was not run.
 */
export type Attribution =
  | { kind: "none" }
  | { kind: "not-attributable"; reason: string }
  | { kind: "perturbation"; facets: string[] }
  | { kind: "facets"; facets: string[] }
  | { kind: "interaction"; facets: string[] }
  | { kind: "not-ablated"; facets: string[] };

export interface AttributionInput {
  verdict: Verdict;
  facets: string[];
  /** True for a perturbation that changes a single thing. */
  singleFacet: boolean;
  baselineVerdict: Verdict;
  /** Facet ablation verdicts, keyed by facet label; undefined when ablation did not run. */
  ablation?: ReadonlyArray<{ facets: string[]; verdict: Verdict }>;
}

export function attribute(input: AttributionInput): Attribution {
  if (isSuccess(input.verdict)) {
    return { kind: "none" };
  }
  if (input.verdict === "error") {
    return { kind: "not-attributable", reason: "harness error during the replay" };
  }
  if (!isSuccess(input.baselineVerdict)) {
    return {
      kind: "not-attributable",
      reason: `the baseline itself is ${input.baselineVerdict}`,
    };
  }
  if (input.singleFacet) {
    return { kind: "perturbation", facets: input.facets };
  }
  if (!input.ablation) {
    return { kind: "not-ablated", facets: input.facets };
  }
  const breaking = input.ablation
    .filter((entry) => !isSuccess(entry.verdict) && entry.verdict !== "error")
    .flatMap((entry) => entry.facets);
  return breaking.length > 0
    ? { kind: "facets", facets: breaking }
    : { kind: "interaction", facets: input.facets };
}

export function describeAttribution(attribution: Attribution): string {
  switch (attribution.kind) {
    case "none":
      return "";
    case "not-attributable":
      return `not attributable: ${attribution.reason}`;
    case "perturbation":
      return attribution.facets.join(", ");
    case "facets":
      return `facet alone: ${attribution.facets.join(", ")}`;
    case "interaction":
      return `no facet fails alone (combination of ${attribution.facets.join(", ")})`;
    case "not-ablated":
      return `one of ${attribution.facets.join(", ")} (run with --ablate to isolate)`;
  }
}
