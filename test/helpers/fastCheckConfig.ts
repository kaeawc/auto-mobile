const DEFAULT_NUM_RUNS = 50;
const MAX_NUM_RUNS = 50;
const PROPERTY_SEED = 1_234_567;

type PropertyParamsOverrides = {
  numRuns?: number;
};

/** Return deterministic fast-check parameters with a hard upper bound on work. */
export function propertyParams(overrides: PropertyParamsOverrides = {}): {
  numRuns: number;
  seed: number;
} {
  const requestedRuns = overrides.numRuns ?? DEFAULT_NUM_RUNS;
  return {
    numRuns: Math.min(Math.max(1, Math.floor(requestedRuns)), MAX_NUM_RUNS),
    seed: PROPERTY_SEED,
  };
}
