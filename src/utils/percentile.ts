/**
 * Percentile over a pre-sorted ascending array, using linear interpolation
 * between the two ranks that bracket the requested position.
 *
 * This is the canonical percentile primitive for the repo — it was previously
 * duplicated verbatim as a private helper in both `src/server/networkGraph.ts`
 * and `src/server/networkResources.ts`, and is reused by the WebRTC egress
 * baseline aggregation (#4387). The contract is unchanged from those copies:
 * the caller sorts ascending first (the function reads positionally and does
 * not re-sort), and an empty array yields `0`.
 *
 * @param sorted values sorted ascending
 * @param p percentile in the range [0, 100]
 */
export function computePercentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sorted[lower];
  }
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}
