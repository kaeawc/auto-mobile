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
  /**
   * Janky frames per second, normalized by the time the samples cover, or
   * `null` when that span is unknown (a single sample carries no duration), so
   * a warm-up snapshot never publishes a fabricated rate.
   */
  perSecond: number | null;
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

/**
 * On-device frame-time distribution (milliseconds) read straight from
 * `dumpsys gfxinfo`'s native percentile histogram. Unlike `fps` (which
 * summarizes per-interval median frame times across the window), this exposes
 * the within-interval tail — the slow frames that windowed medians hide.
 *
 * Because gfxinfo computes these over the frames of a single ~500ms interval
 * and percentiles do not average across intervals, the snapshot reports the
 * most recent frame-bearing interval rather than fabricating a
 * percentile-of-percentiles. It costs no extra device work: the sampler already
 * runs `dumpsys gfxinfo ... reset` every tick and only read the 50th line.
 */
export interface FrameTimePercentiles {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
}

/**
 * App startup timing captured at the most recent launch (milliseconds).
 *
 * Sourced from the ActivityManager "Displayed" logcat line that `launchApp`
 * already reads at launch and caches in-process — surfacing it here is an
 * in-memory lookup, so it adds no device work. `null` when no launch was
 * recorded for this package within the recency window.
 */
export interface StartupTimingSummary {
  /**
   * Time from launch to the first displayed frame (ActivityManager "Displayed"
   * time). This is the app's cold/warm startup latency as the framework reports it.
   */
  displayedMs: number;
  /** Age of this launch measurement relative to the snapshot time (milliseconds). */
  ageMs: number;
}

/**
 * Per-component memory breakdown (megabytes, PSS) from `dumpsys meminfo`'s App
 * Summary. `dumpsys meminfo` already computes this whole table for the
 * `memoryMb` (TOTAL PSS) reading; parsing the extra rows adds no device work.
 * Each field is `null` when that row was absent (older Android without an App
 * Summary section). This is the latest in-window reading, not a windowed
 * average — memory composition changes slowly and is sampled infrequently.
 */
export interface MemoryBreakdownMb {
  javaHeap: number | null;
  nativeHeap: number | null;
  code: number | null;
  stack: number | null;
  graphics: number | null;
  privateOther: number | null;
  system: number | null;
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
  /**
   * On-device frame-time percentiles (ms) from gfxinfo's native histogram for
   * the most recent frame-bearing interval, or null when no such interval fell
   * in the window. Complements `fps` by exposing within-interval tail latency.
   */
  frameTimeMs: FrameTimePercentiles | null;
  /** Janky-frame rollup, or null when no jank samples were seen. */
  jank: JankSummary | null;
  /** Touch-latency rollup (ms), or null when no touch-latency samples were seen. */
  touchLatencyMs: TouchLatencySummary | null;
  /** CPU usage percent (0-100), or null when no CPU samples were seen. */
  cpu: AverageLatestSummary | null;
  /** Memory usage in MB, or null when no memory samples were seen. */
  memoryMb: AverageLatestSummary | null;
  /**
   * Per-component memory breakdown (MB) from the latest in-window meminfo App
   * Summary, or null when no breakdown was captured in the window.
   */
  memoryBreakdownMb: MemoryBreakdownMb | null;
  /**
   * App startup timing from the most recent launch, or null when no recent
   * launch was recorded for this package.
   */
  startup: StartupTimingSummary | null;
}
