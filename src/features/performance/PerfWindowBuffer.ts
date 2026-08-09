import { computePercentile } from "../../utils/percentile";
import type {
  AverageLatestSummary,
  JankSummary,
  PercentileSummary,
  PerfSnapshot,
  TouchLatencySummary,
} from "../../models/PerfSnapshot";

/**
 * A single performance sample recorded into the window. Every metric is
 * `number | null` — the live stream reports null when a metric could not be
 * measured this tick (e.g. no frames rendered → fps/frameTime null).
 */
export interface PerfSample {
  /** Monotonic sample timestamp (ms), as produced by the sampler's `now`. */
  t: number;
  fps: number | null;
  frameTimeMs: number | null;
  jankFrames: number | null;
  touchLatencyMs: number | null;
  cpuUsagePercent: number | null;
  memoryUsageMb: number | null;
}

/**
 * Per-device sliding-window buffer of performance samples.
 *
 * The buffer is source-agnostic: it is fed at the single fan-out point every
 * live sample flows through (`PerformanceMonitor.pushMetrics`). `observe` then
 * asks for a windowed `snapshot()` to attach to its result. Because it taps
 * that one chokepoint, a future denser source (e.g. an on-device SDK
 * FrameMetrics feed, #5076, or a real per-app iOS source, #5078) improves the
 * snapshot with no changes here.
 *
 * On iOS today only the host-side CPU/memory (by bundle id) flow through, so an
 * iOS snapshot has real cpu/memory and null fps/jank — the CtrlProxy's on-device
 * CADisplayLink measures the test-runner process, not the app, so it is
 * deliberately not fed here (see IOSCtrlProxyClient.handlePerformanceUpdate).
 *
 * Time is always passed in (`now`) rather than read from a clock, so unit tests
 * stay deterministic without a FakeTimer.
 */
export class PerfWindowBuffer {
  /**
   * Hard per-device cap on retained samples, so a long-lived session cannot
   * grow the buffer without bound even if callers request a large window. At
   * the 500ms sampling tier this is ~4 minutes of history — far more than any
   * reasonable window.
   */
  static readonly MAX_SAMPLES_PER_DEVICE = 512;

  private readonly samplesByDevice = new Map<string, PerfSample[]>();

  /**
   * Record a sample for a device. Samples are assumed to arrive in
   * non-decreasing `now` order (the sampler is a single timer). Older-than-cap
   * samples are evicted from the front to bound memory.
   */
  record(deviceId: string, sample: PerfSample): void {
    let samples = this.samplesByDevice.get(deviceId);
    if (!samples) {
      samples = [];
      this.samplesByDevice.set(deviceId, samples);
    }
    samples.push(sample);
    if (samples.length > PerfWindowBuffer.MAX_SAMPLES_PER_DEVICE) {
      samples.splice(0, samples.length - PerfWindowBuffer.MAX_SAMPLES_PER_DEVICE);
    }
  }

  /**
   * Drop all retained samples for a device (e.g. when monitoring stops or the
   * device disconnects).
   */
  clear(deviceId: string): void {
    this.samplesByDevice.delete(deviceId);
  }

  /**
   * Build a windowed snapshot for a device over `[now - windowMs, now]`.
   *
   * Samples outside the window are also pruned from storage as a side effect,
   * keeping the buffer trimmed to what recent snapshots actually use.
   */
  snapshot(deviceId: string, now: number, windowMs: number): PerfSnapshot {
    const samples = this.samplesByDevice.get(deviceId) ?? [];
    const cutoff = now - windowMs;

    // Prune anything older than the window, then keep the trimmed array.
    const inWindow = samples.filter(s => s.t >= cutoff && s.t <= now);
    if (inWindow.length !== samples.length) {
      this.samplesByDevice.set(deviceId, inWindow);
    }

    const oldest = inWindow.length > 0 ? inWindow[0] : null;

    return {
      windowMs,
      sampleCount: inWindow.length,
      oldestSampleAgeMs: oldest !== null ? now - oldest.t : null,
      fps: percentileSummary(collect(inWindow, s => s.fps)),
      // A jank sample describes the interval ending at its timestamp. A
      // sample exactly on the cutoff therefore began before this window.
      jank: jankSummary(inWindow.filter(sample => sample.t > cutoff)),
      touchLatencyMs: touchLatencySummary(inWindow),
      cpu: averageLatestSummary(collect(inWindow, s => s.cpuUsagePercent)),
      memoryMb: averageLatestSummary(collect(inWindow, s => s.memoryUsageMb)),
    };
  }
}

/** Collect the non-null values of one metric, preserving sample order. */
function collect(samples: PerfSample[], pick: (s: PerfSample) => number | null): number[] {
  const values: number[] = [];
  for (const s of samples) {
    const v = pick(s);
    if (v !== null && Number.isFinite(v)) {
      values.push(v);
    }
  }
  return values;
}

/** Percentiles over an unsorted value list (sorts ascending first). */
function percentileSummary(values: number[]): PercentileSummary | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: round2(computePercentile(sorted, 50)),
    p90: round2(computePercentile(sorted, 90)),
    p95: round2(computePercentile(sorted, 95)),
    p99: round2(computePercentile(sorted, 99)),
  };
}

/** Sum of janky frames plus a per-second rate over the covered span. */
function jankSummary(samples: PerfSample[]): JankSummary | null {
  const withJank = samples.filter(s => s.jankFrames !== null && Number.isFinite(s.jankFrames));
  if (withJank.length === 0) {
    return null;
  }
  let total = 0;
  for (const s of withJank) {
    total += s.jankFrames as number;
  }
  // Each jank sample is a count for ONE sampling interval. The `n` samples span
  // `newest - oldest` across `n - 1` gaps, so the time they actually cover is
  // `n` intervals = span * n/(n-1). Dividing by a bare `newest - oldest` (or
  // `now - oldest`) drops the oldest sample's own interval and inflates the
  // rate (e.g. two 500ms samples totaling 5 → 10/s instead of 5/s). With a
  // single sample (or a zero span) there is no known interval duration, so the
  // rate is `null` rather than a fabricated 1s figure.
  const n = withJank.length;
  const spanMs = withJank[n - 1].t - withJank[0].t;
  const coverageMs = n >= 2 && spanMs > 0 ? (spanMs * n) / (n - 1) : 0;
  const perSecond = coverageMs > 0 ? round2((total / coverageMs) * 1000) : null;
  return { total, perSecond };
}

function touchLatencySummary(samples: PerfSample[]): TouchLatencySummary | null {
  const values = collect(samples, s => s.touchLatencyMs);
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: round2(computePercentile(sorted, 50)),
    p95: round2(computePercentile(sorted, 95)),
    latest: values[values.length - 1],
  };
}

function averageLatestSummary(values: number[]): AverageLatestSummary | null {
  if (values.length === 0) {
    return null;
  }
  let sum = 0;
  for (const v of values) {
    sum += v;
  }
  return {
    avg: round2(sum / values.length),
    latest: values[values.length - 1],
  };
}

/** Round to 2 decimal places to keep the wire payload compact. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

let singleton: PerfWindowBuffer | null = null;

/** Process-wide buffer shared by the sampler (writer) and observe (reader). */
export function getPerfWindowBuffer(): PerfWindowBuffer {
  if (singleton === null) {
    singleton = new PerfWindowBuffer();
  }
  return singleton;
}
