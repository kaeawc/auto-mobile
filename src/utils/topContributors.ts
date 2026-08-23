/**
 * Shared selection of the "Top contributors" list rendered by the memory and
 * performance audit diagnostics.
 *
 * Both audits assign every violation a `contributionWeight` in [0, 1] and then
 * render the highest-weighted ones under a "Top contributors:" heading. The
 * naive `weight > THRESHOLD` filter used previously could return an empty list
 * for a non-empty violation set — e.g. a CPU-only performance violation carries
 * weight exactly 0.5, which `> 0.5` excludes — producing a heading with nothing
 * under it (issue #4167).
 */

/** Violations at or above this weight are always reported as top contributors. */
export const TOP_CONTRIBUTOR_WEIGHT_THRESHOLD = 0.5;

/** Minimal shape needed to rank a violation. */
export interface WeightedContribution {
  contributionWeight: number;
}

/**
 * Sort violations by contribution weight (highest first) and select the top
 * contributors.
 *
 * The effective cut-off is `min(TOP_CONTRIBUTOR_WEIGHT_THRESHOLD, maxWeight)`
 * and the comparison is inclusive, which guarantees two properties:
 *
 * 1. A non-empty violation set always yields at least one top contributor, so
 *    the rendered section can never be an empty heading, whatever weights a
 *    future violation type is given.
 * 2. Violations weighted below the threshold are still excluded whenever any
 *    violation meets it, preserving the existing "top" semantics.
 */
export function selectTopContributors<T extends WeightedContribution>(violations: T[]): T[] {
  if (violations.length === 0) {
    return [];
  }

  const sorted = [...violations].sort((a, b) => b.contributionWeight - a.contributionWeight);
  const cutoff = Math.min(TOP_CONTRIBUTOR_WEIGHT_THRESHOLD, sorted[0].contributionWeight);

  return sorted.filter((violation) => violation.contributionWeight >= cutoff);
}
