/**
 * Windowed performance snapshot attached to an ObserveResult when the
 * `AUTOMOBILE_OBSERVE_PERF_SNAPSHOT` opt-in is enabled.
 *
 * The snapshot summarizes the live performance stream (produced by
 * `PerformanceMonitor` and any future on-device source) over a rolling time
 * window — see `src/features/performance/PerfWindowBuffer.ts`. It is a
 * deliberately small, human-readable rollup: fps percentiles, jank, touch
 * latency, CPU, and memory. All sub-objects are `null` when the window held no
 * samples for that metric (e.g. an idle app renders no frames, so `fps` stays
 * null while `cpu`/`memoryMb` still populate).
 */

/** Percentile spread over the sampled values in the window. */
export interface PercentileSummary {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

/** Jank rollup over the window. */
export interface JankSummary {
  /** Total janky frames observed across the window's samples. */
  total: number;
  /** Janky frames per second, normalized by the window span the samples cover. */
  perSecond: number;
}

/** Touch-latency rollup (milliseconds). */
export interface TouchLatencySummary {
  p50: number;
  p95: number;
  /** Most recent touch-latency sample in the window. */
  latest: number;
}

/** Average + latest rollup for a scalar metric. */
export interface AverageLatestSummary {
  avg: number;
  latest: number;
}

export interface PerfSnapshot {
  /** The window span requested for this snapshot (milliseconds). */
  windowMs: number;
  /** Number of samples that fell inside the window. */
  sampleCount: number;
  /**
   * Age of the oldest in-window sample relative to the snapshot time
   * (milliseconds), or null when the window is empty. Small values on the first
   * observe of a session signal the window is still warming up.
   */
  oldestSampleAgeMs: number | null;
  /** Frames-per-second percentiles, or null when no frame samples were seen. */
  fps: PercentileSummary | null;
  /** Janky-frame rollup, or null when no jank samples were seen. */
  jank: JankSummary | null;
  /** Touch-latency rollup (ms), or null when no touch-latency samples were seen. */
  touchLatencyMs: TouchLatencySummary | null;
  /** CPU usage percent (0-100), or null when no CPU samples were seen. */
  cpu: AverageLatestSummary | null;
  /** Memory usage in MB, or null when no memory samples were seen. */
  memoryMb: AverageLatestSummary | null;
}
