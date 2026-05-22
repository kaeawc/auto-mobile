import type { LatencyPercentiles } from "./types";

/**
 * Linear-interpolation percentile, identical in semantics to the existing
 * private implementation in `src/server/networkGraph.ts`. Extracted here so
 * the run-health summary and any future diagnostics can share one
 * implementation without depending on the networkGraph internals.
 *
 * `sortedAsc` must be sorted ascending. Returns 0 for an empty input.
 */
export function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) {
    return 0;
  }
  const index = (p / 100) * (sortedAsc.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) {
    return sortedAsc[lower];
  }
  return sortedAsc[lower] + (sortedAsc[upper] - sortedAsc[lower]) * (index - lower);
}

/**
 * Roll an unsorted sample into a `LatencyPercentiles` record. Sorts internally
 * (caller does not need to pre-sort). Empty samples produce all-zero output;
 * callers should still emit the surrounding shape with `count: 0` so the JSON
 * stays self-describing.
 */
export function summarizeLatencies(samples: number[]): LatencyPercentiles {
  if (samples.length === 0) {
    return {
      count: 0,
      minMs: 0,
      p50Ms: 0,
      p90Ms: 0,
      p99Ms: 0,
      maxMs: 0,
    };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: Math.round(percentile(sorted, 50)),
    p90Ms: Math.round(percentile(sorted, 90)),
    p99Ms: Math.round(percentile(sorted, 99)),
    maxMs: sorted[sorted.length - 1],
  };
}
