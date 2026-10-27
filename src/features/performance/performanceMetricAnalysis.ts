import { DEFAULT_THRESHOLDS } from "../../daemon/performancePushSocketServer";
import type { FrameTimePercentiles, MemoryBreakdownMb } from "../../models/PerfSnapshot";
import type { MonitoredDevice, PerformanceMonitor } from "./PerformanceMonitor";
import type { SdkFrameSample } from "./SdkFrameMetricsStore";

export interface GfxMetrics {
  fps: number | null;
  frameTimeMs: number | null;
  jankFrames: number | null;
  /** Number of frames with high input latency in this interval */
  highInputLatencyFrames: number | null;
  /** Total frames rendered in this interval (for calculating latency ratio) */
  totalFrames: number | null;
  /**
   * gfxinfo's native frame-time percentile histogram for this interval, or null
   * when no frames rendered. Parsed from the same dumpsys output as `frameTimeMs`
   * (its 50th percentile), so it adds no device work.
   */
  frameTimePercentilesMs: FrameTimePercentiles | null;
}
export interface RawJankCounters {
  missedVsync: number;
  slowUi: number;
  deadlineMissed: number;
  /**
   * gfxinfo's aggregate "Janky frames" count for the interval, or null when the
   * output has no such line (older Android). Preferred over summing the cause
   * counters above, which overlap (one frame can trip several).
   */
  jankyFrames: number | null;
}
export interface AndroidFrameMetrics {
  fps: number | null;
  frameTimeMs: number | null;
  jankFrames: number | null;
  touchLatencyMs: number;
  rawFps: number | null;
  rawFrameTimeMs: number | null;
  rawTouchLatencyMs: number | null;
}
interface RawWindowSample {
  fps: number | null;
  frameTimeMs: number | null;
  jankFrames: number | null;
  touchLatencyMs: number | null;
  cpuUsagePercent: number | null;
  memoryUsageMb: number | null;
  frameTimePercentilesMs: FrameTimePercentiles | null;
  memoryBreakdownMb: MemoryBreakdownMb | null;
}

export function resolveAndroidFrameMetrics(
  device: MonitoredDevice,
  sdkFrame: SdkFrameSample | null,
  gfx: (GfxMetrics & { rawJankCounters: RawJankCounters | null }) | null,
): AndroidFrameMetrics {
  let fps: number | null;
  let frameTimeMs: number | null;
  let jankFrames: number | null;
  let touchLatencyMs: number;
  let rawFps: number | null;
  let rawFrameTimeMs: number | null;
  let rawTouchLatencyMs: number | null;

  if (sdkFrame) {
    // Real app-process frames from the in-app SDK.
    rawFps = sdkFrame.fps;
    rawFrameTimeMs = sdkFrame.frameTimeMs;
    jankFrames = sdkFrame.jankFrames;
    if (sdkFrame.fps !== null) {
      device.cachedFps = sdkFrame.fps;
    }
    if (sdkFrame.frameTimeMs !== null) {
      device.cachedFrameTime = sdkFrame.frameTimeMs;
    }
    fps = sdkFrame.fps ?? device.cachedFps;
    frameTimeMs = sdkFrame.frameTimeMs ?? device.cachedFrameTime;
    // The SDK does not measure touch latency; keep the buffer honest (null)
    // while the stream shows the idle-responsive fallback.
    rawTouchLatencyMs = null;
    touchLatencyMs = 16;
  } else {
    const gfxData = gfx!;
    if (gfxData.fps !== null && gfxData.frameTimeMs !== null) {
      device.cachedFps = gfxData.fps;
      device.cachedFrameTime = gfxData.frameTimeMs;
      fps = gfxData.fps;
      frameTimeMs = gfxData.frameTimeMs;
    } else {
      // No frames rendered this interval - use cached values for the stream.
      fps = device.cachedFps;
      frameTimeMs = device.cachedFrameTime;
    }

    // Prefer gfxinfo's aggregate "Janky frames" count. The individual cause
    // counters overlap (one frame can trip several), so summing them
    // double-counts; fall back to the sum only when the aggregate is absent.
    jankFrames = null;
    if (gfxData.rawJankCounters) {
      const curr = gfxData.rawJankCounters;
      jankFrames = curr.jankyFrames ?? curr.missedVsync + curr.slowUi + curr.deadlineMissed;
    }

    const touch = estimateTouchLatency(gfxData, frameTimeMs, device);
    touchLatencyMs = touch.streamMs;
    rawTouchLatencyMs = touch.rawMs;
    rawFps = gfxData.fps;
    rawFrameTimeMs = gfxData.frameTimeMs;
  }
  return {
    fps,
    frameTimeMs,
    jankFrames,
    touchLatencyMs,
    rawFps,
    rawFrameTimeMs,
    rawTouchLatencyMs,
  };
}

export function createAndroidWindowSample({
  recordGfxWindowSample,
  frameMetrics,
  gfx,
  shouldCollectCpu,
  cpu,
  shouldCollectMemory,
  memory,
  memoryBreakdown,
}: {
  recordGfxWindowSample: boolean;
  frameMetrics: AndroidFrameMetrics;
  gfx: GfxMetrics | null;
  shouldCollectCpu: boolean;
  cpu: number | null;
  shouldCollectMemory: boolean;
  memory: number | null;
  memoryBreakdown: MemoryBreakdownMb | null;
}): RawWindowSample {
  const { rawFps, rawFrameTimeMs, jankFrames, rawTouchLatencyMs } = frameMetrics;
  return {
    fps: recordGfxWindowSample ? rawFps : null,
    frameTimeMs: recordGfxWindowSample ? rawFrameTimeMs : null,
    jankFrames: recordGfxWindowSample ? jankFrames : null,
    touchLatencyMs: recordGfxWindowSample ? rawTouchLatencyMs : null,
    // Native gfxinfo percentiles follow the same priming gate as the raw frame
    // readings; the SDK path (gfx === null) contributes none.
    frameTimePercentilesMs: recordGfxWindowSample ? (gfx?.frameTimePercentilesMs ?? null) : null,
    // CPU/memory only when actually collected this tick (null otherwise), so
    // the window never averages a reading acquired outside it.
    cpuUsagePercent: shouldCollectCpu ? cpu : null,
    memoryUsageMb: shouldCollectMemory ? memory : null,
    memoryBreakdownMb: shouldCollectMemory ? memoryBreakdown : null,
  };
}

/**
 * Estimate Android touch latency from the interval's frame stats. Returns the
 * stream value (a fabricated 16ms when the app is idle so the live gauge stays
 * responsive) and the raw value (null when idle, so the windowed buffer records
 * only genuine measurements). "High input latency" frames scale the estimate
 * from ~2x frame time (a few) to ~4x (many).
 */
export function estimateTouchLatency(
  gfx: { totalFrames: number | null; highInputLatencyFrames: number | null },
  frameTimeMs: number | null,
  device: MonitoredDevice,
): { streamMs: number; rawMs: number | null } {
  if (gfx.totalFrames === null || gfx.totalFrames <= 0 || frameTimeMs === null) {
    // No frames this interval - assume optimal latency (idle app is responsive).
    return { streamMs: 16, rawMs: null };
  }
  const highLatency = gfx.highInputLatencyFrames !== null && gfx.highInputLatencyFrames > 0;
  const multiplier = highLatency ? 2 + (gfx.highInputLatencyFrames! / gfx.totalFrames) * 2 : 1;
  const ms = Math.round(frameTimeMs * multiplier);
  device.cachedTouchLatency = ms;
  return { streamMs: ms, rawMs: ms };
}

export function consumeGfxPriming(
  device: MonitoredDevice,
  sdkFrame: unknown,
  resetSucceeded: boolean,
): boolean {
  const hasSdkFrame = sdkFrame !== null;
  if (hasSdkFrame) {
    // SDK samples are interval-scoped. A later fallback must still be treated
    // as its first cumulative read after the SDK feed goes stale.
    device.gfxPrimed = false;
    return true;
  }
  if (!resetSucceeded) {
    // A caught ADB error did not establish a reset baseline. Keep priming
    // pending so the first successful reset is also excluded.
    return false;
  }
  const shouldRecord = device.gfxPrimed;
  device.gfxPrimed = true;
  return shouldRecord;
}

export function classifyMetricHealth(
  metrics: Parameters<PerformanceMonitor["emitPerformanceTelemetry"]>[2],
): Record<string, string> {
  const th = DEFAULT_THRESHOLDS;
  const currentHealth: Record<string, string> = {};

  // Classify each metric
  if (metrics.fps !== null) {
    currentHealth.fps =
      metrics.fps < th.fpsCritical
        ? "critical"
        : metrics.fps < th.fpsWarning
          ? "warning"
          : "healthy";
  }
  if (metrics.frameTimeMs !== null) {
    currentHealth.frameTime = classifyHighMetricHealth(
      metrics.frameTimeMs,
      th.frameTimeCritical,
      th.frameTimeWarning,
    );
  }
  if (metrics.jankFrames !== null) {
    currentHealth.jank = classifyHighMetricHealth(
      metrics.jankFrames,
      th.jankCritical,
      th.jankWarning,
    );
  }
  if (metrics.touchLatencyMs !== null) {
    currentHealth.touchLatency = classifyHighMetricHealth(
      metrics.touchLatencyMs,
      th.touchLatencyCritical,
      th.touchLatencyWarning,
    );
  }
  if (metrics.memoryUsageMb !== null) {
    // Classify memory into bands — emit telemetry when band changes.
    // Thresholds based on typical Android app memory budgets.
    const mb = metrics.memoryUsageMb;
    currentHealth.memory = classifyHighMetricHealth(mb, 300, 200);
  }
  return currentHealth;
}

export function classifyHighMetricHealth(value: number, critical: number, warning: number): string {
  return value > critical ? "critical" : value > warning ? "warning" : "healthy";
}

export function fpsFromFrameTime(frameTimeMs: number | null): number | null {
  return frameTimeMs && frameTimeMs > 0 ? Math.min(1000 / frameTimeMs, 60) : null;
}

export function parseGfxMetrics(
  stdout: string,
): GfxMetrics & { rawJankCounters: RawJankCounters | null; resetSucceeded: boolean } {
  // Check if any frames were actually rendered in this interval
  const totalFramesMatch = stdout.match(/Total frames rendered:\s+(\d+)/);
  const totalFrames = totalFramesMatch ? parseInt(totalFramesMatch[1], 10) : 0;

  // Only parse frame-time percentiles if frames were rendered (otherwise
  // gfxinfo prints garbage default values). gfxinfo already computes this
  // native histogram for the same interval we reset each tick, so surfacing
  // it costs no extra device work.
  let frameTimeMs: number | null = null;
  let frameTimePercentilesMs: FrameTimePercentiles | null = null;
  if (totalFrames > 0) {
    frameTimeMs = parsePercentileMs(stdout, 50);
    frameTimePercentilesMs = parseFrameTimePercentiles(stdout);
  }

  // Parse jank counters (now reflects only jank since last reset)
  const missedVsync = parseInt(stdout.match(/Missed Vsync:\s+(\d+)/)?.[1] || "0", 10);
  const slowUi = parseInt(stdout.match(/Slow UI thread:\s+(\d+)/)?.[1] || "0", 10);
  const deadlineMissed = parseInt(stdout.match(/Frame deadline missed:\s+(\d+)/)?.[1] || "0", 10);
  // Aggregate janky-frame count (deduplicated across causes) when present.
  const jankyMatch = stdout.match(/Janky frames:\s+(\d+)/);
  const jankyFrames = jankyMatch ? parseInt(jankyMatch[1], 10) : null;

  // Parse high input latency frame count
  const highInputLatencyMatch = stdout.match(/Number High input latency:\s+(\d+)/);
  const highInputLatencyFrames = highInputLatencyMatch
    ? parseInt(highInputLatencyMatch[1], 10)
    : null;

  // Calculate FPS from frame time
  const fps = fpsFromFrameTime(frameTimeMs);

  return {
    fps,
    frameTimeMs,
    jankFrames: null, // Computed as delta in sampleDevice
    highInputLatencyFrames,
    totalFrames,
    frameTimePercentilesMs,
    rawJankCounters: { missedVsync, slowUi, deadlineMissed, jankyFrames },
    resetSucceeded: true,
  };
}

/**
 * Parse one `dumpsys gfxinfo` frame-time percentile line (e.g. `90th
 * percentile: 12ms`), returning the millisecond value or null when absent.
 */
function parsePercentileMs(stdout: string, percentile: number): number | null {
  const match = stdout.match(new RegExp(`${percentile}th percentile:\\s+(\\d+(?:\\.\\d+)?)ms`));
  return match ? parseFloat(match[1]) : null;
}

/**
 * Assemble gfxinfo's native frame-time percentile histogram (p50/p90/p95/p99)
 * from one dumpsys output. Returns null unless the full set is present, so the
 * snapshot never reports a partial percentile summary.
 */
function parseFrameTimePercentiles(stdout: string): FrameTimePercentiles | null {
  const p50 = parsePercentileMs(stdout, 50);
  const p90 = parsePercentileMs(stdout, 90);
  const p95 = parsePercentileMs(stdout, 95);
  const p99 = parsePercentileMs(stdout, 99);
  if (p50 === null || p90 === null || p95 === null || p99 === null) {
    return null;
  }
  return { p50, p90, p95, p99 };
}
export /**
 * Parse the `dumpsys meminfo` App Summary block into a per-component MB
 * breakdown. Each row prints its Pss column as the first number after the
 * label; a missing row yields null for that component. Returns null when the
 * output has no App Summary at all (very old Android).
 */
function parseMemoryBreakdown(stdout: string): MemoryBreakdownMb | null {
  const kbToMb = (label: string): number | null => {
    const match = stdout.match(new RegExp(`${label}:\\s+(\\d+)`));
    return match ? parseInt(match[1], 10) / 1024 : null;
  };
  const breakdown: MemoryBreakdownMb = {
    javaHeap: kbToMb("Java Heap"),
    nativeHeap: kbToMb("Native Heap"),
    code: kbToMb("Code"),
    stack: kbToMb("Stack"),
    graphics: kbToMb("Graphics"),
    privateOther: kbToMb("Private Other"),
    system: kbToMb("System"),
  };
  // No App Summary section → every row missing; report null rather than an
  // all-null object so consumers can distinguish "unsupported" from "0".
  const hasAny = Object.values(breakdown).some((v) => v !== null);
  return hasAny ? breakdown : null;
}
