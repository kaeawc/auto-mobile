/**
 * Bounded summary of one recorded trace (#14102). Tool output carries this,
 * never raw tables: the full trace stays in the artifact file.
 */
export interface PerformanceTraceSummary {
  durationMs?: number;
  /** Why the recorder stopped, when the tracer reports it (`Time limit reached`). */
  endReason?: string;
  launch?: { durationMs: number; phases: Array<{ name: string; durationMs: number }> };
  hitches?: { count: number; totalDurationMs: number; maxDurationMs: number };
  hangs?: Array<{ durationMs: number; startMs?: number; type?: string }>;
  topFunctions?: Array<{ name: string; samples: number }>;
  /** Sampled native heap allocations (Android heapprofd). */
  allocations?: { bytes: number; count: number };
}

export const SUMMARY_MAX_ITEMS = 10;

export function nanosToMs(nanos: number): number {
  return Math.round(nanos / 1_000) / 1_000;
}

/** Count leaf-function samples and keep the busiest {@link SUMMARY_MAX_ITEMS}. */
export function topCounts(names: readonly string[]): Array<{ name: string; samples: number }> {
  const counts = new Map<string, number>();
  for (const name of names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, SUMMARY_MAX_ITEMS)
    .map(([name, samples]) => ({ name, samples }));
}

export function hitchStats(durationsMs: readonly number[]): PerformanceTraceSummary["hitches"] {
  return {
    count: durationsMs.length,
    totalDurationMs: Math.round(durationsMs.reduce((sum, value) => sum + value, 0) * 1_000) / 1_000,
    maxDurationMs: durationsMs.length > 0 ? Math.max(...durationsMs) : 0,
  };
}
