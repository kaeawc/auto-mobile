import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import {
  getPerformancePushServer,
  LivePerformanceData,
  DEFAULT_THRESHOLDS,
  PerformancePushSocketServer,
} from "../../daemon/performancePushSocketServer";
import {
  getDeviceDataStreamServer,
  PerformanceStreamData,
} from "../../daemon/deviceDataStreamSocketServer";
import { RecompositionTracker } from "./RecompositionTracker";
import { getPerfWindowBuffer, PerfWindowBuffer } from "./PerfWindowBuffer";
import { getSdkFrameMetricsStore, SdkFrameMetricsStore } from "./SdkFrameMetricsStore";
import type {
  FrameTimePercentiles,
  MemoryBreakdownMb,
  StartupTimingSummary,
} from "../../models/PerfSnapshot";
import { TelemetryRecorder } from "../telemetry/TelemetryRecorder";
import {
  defaultAdbClientFactory,
  AdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { SimCtlClient, SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { execFile } from "child_process";
import { promisify } from "util";

const defaultExecFileAsync = promisify(execFile);

/** Minimal interface for performance telemetry emission. */
export interface PerformanceTelemetryEmitter {
  setContext(deviceId: string | null, sessionId: string | null): void;
  recordPerformanceEvent: TelemetryRecorder["recordPerformanceEvent"];
}

/**
 * Type for the exec function used to run host commands.
 * Injected for testing.
 */
export type ExecFileAsyncFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/**
 * Factory interface for creating SimCtlClient instances.
 * Enables dependency injection for testing.
 */
export interface SimCtlClientFactory {
  create(deviceId: string): SimCtl;
}

/**
 * Default factory that creates real SimCtlClient instances.
 */
class DefaultSimCtlClientFactory implements SimCtlClientFactory {
  create(deviceId: string): SimCtl {
    return new SimCtlClient({ deviceId, name: deviceId, platform: "ios" });
  }
}

/**
 * Singleton instance of the default factory.
 */
export const defaultSimCtlClientFactory: SimCtlClientFactory = new DefaultSimCtlClientFactory();

interface GfxMetrics {
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

/**
 * Raw cumulative jank counters from dumpsys gfxinfo.
 * These are cumulative since last reset, so we need to track deltas.
 */
interface RawJankCounters {
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

interface PreviousCpuSample {
  processTicks: number;
  uptimeSeconds: number;
}

interface CpuMetricsResult {
  cpuUsagePercent: number | null;
  sample: PreviousCpuSample | null;
}

interface MonitoredDevice {
  deviceId: string;
  packageName: string;
  /**
   * Monotonically increasing token bumped on every package switch. Lets an
   * in-flight sample detect an A→B→A sequence that a package-name comparison
   * alone would miss (the name is back to A, but it's a different session).
   */
  monitoringGeneration: number;
  platform: "android" | "ios";
  lastFastTick: number;
  lastMediumTick: number;
  lastSlowTick: number;
  cachedCpu: number | null;
  cachedMemory: number | null;
  /** Cached meminfo App Summary breakdown, carried between slow ticks. */
  cachedMemoryBreakdown: MemoryBreakdownMb | null;
  /** Cached FPS from last interval with actual frames */
  cachedFps: number | null;
  /** Cached frame time from last interval with actual frames */
  cachedFrameTime: number | null;
  /** Cached touch latency from last interval with actual frames */
  cachedTouchLatency: number | null;
  /** Previous jank counters for computing deltas */
  prevJankCounters: RawJankCounters | null;
  /** PID of the app process (cached for iOS since it requires a lookup) */
  cachedPid: number | null;
  /** Previous Android process CPU sample for interval-delta calculation */
  previousCpuSample: PreviousCpuSample | null;
  /** Whether the cumulative first gfxinfo sample has already been primed */
  gfxPrimed: boolean;
  /** Previous per-metric health for detecting threshold crossings */
  previousMetricHealth: Record<string, string>;
}

/**
 * Interface for pushing performance data, used for testing.
 */
export interface PerformanceDataPusher {
  pushPerformanceData(data: LivePerformanceData): void;
}

/**
 * Function type for getting the performance push server.
 */
export type ServerGetter = () => PerformanceDataPusher | null;

/**
 * Continuous performance monitor that samples device metrics at tiered intervals
 * and pushes them to the IDE via PerformancePushSocketServer.
 *
 * Sampling tiers:
 * - Fast (500ms): FPS, frame time, jank count via dumpsys gfxinfo
 * - Medium (2s): CPU usage via /proc/{pid}/stat
 * - Slow (10s): Memory usage via dumpsys meminfo
 */
export class PerformanceMonitor {
  static readonly TICK_INTERVAL_MS = 500;
  static readonly MEDIUM_INTERVAL_MS = 2000;
  static readonly SLOW_INTERVAL_MS = 10000;
  /**
   * How recent an in-app SDK frame sample must be to be preferred over the
   * dumpsys scrape. The SDK broadcasts ~1/s, so a couple ticks of grace covers
   * normal jitter; an older sample means the feed went quiet and we fall back.
   */
  static readonly SDK_FRAME_TTL_MS = 2500;

  private intervalHandle: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private readonly timer: Timer;
  private readonly adbClientFactory: AdbClientFactory;
  private readonly simCtlClientFactory: SimCtlClientFactory;
  private readonly getServer: ServerGetter;
  private readonly execFileAsync: ExecFileAsyncFn;
  private readonly getTelemetryEmitter: () => PerformanceTelemetryEmitter;
  private readonly perfWindowBuffer: PerfWindowBuffer;
  private readonly frameMetricsStore: SdkFrameMetricsStore;
  private monitoredDevices = new Map<string, MonitoredDevice>();

  constructor(
    timer: Timer = defaultTimer,
    adbClientFactory: AdbClientFactory = defaultAdbClientFactory,
    serverGetter: ServerGetter = getPerformancePushServer,
    simCtlClientFactory: SimCtlClientFactory = defaultSimCtlClientFactory,
    execFileAsync: ExecFileAsyncFn = defaultExecFileAsync,
    getTelemetryEmitter: () => PerformanceTelemetryEmitter = () => TelemetryRecorder.getInstance(),
    perfWindowBuffer: PerfWindowBuffer = getPerfWindowBuffer(),
    frameMetricsStore: SdkFrameMetricsStore = getSdkFrameMetricsStore(),
  ) {
    this.timer = timer;
    this.adbClientFactory = adbClientFactory;
    this.simCtlClientFactory = simCtlClientFactory;
    this.getServer = serverGetter;
    this.execFileAsync = execFileAsync;
    this.getTelemetryEmitter = getTelemetryEmitter;
    this.perfWindowBuffer = perfWindowBuffer;
    this.frameMetricsStore = frameMetricsStore;
  }

  /**
   * Start the background monitoring interval.
   * Does nothing if already started.
   */
  start(): void {
    if (this.intervalHandle) {
      return;
    }

    this.intervalHandle = this.timer.setInterval(() => {
      void this.trigger();
    }, PerformanceMonitor.TICK_INTERVAL_MS);

    logger.info("[PerformanceMonitor] Started background monitoring");
  }

  /**
   * Stop the background monitoring interval.
   */
  stop(): void {
    if (this.intervalHandle) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.pending = null;
    // Discard every device's retained samples along with the monitored set.
    for (const deviceId of this.monitoredDevices.keys()) {
      this.perfWindowBuffer.clear(deviceId);
      this.frameMetricsStore.clear(deviceId);
    }
    this.monitoredDevices.clear();
    logger.info("[PerformanceMonitor] Stopped background monitoring");
  }

  /**
   * Start monitoring a specific device/package combination.
   * @param deviceId - The device identifier
   * @param packageName - The package/bundle identifier to monitor
   * @param platform - The platform ("android" or "ios"), defaults to "android"
   */
  startMonitoring(
    deviceId: string,
    packageName: string,
    platform: "android" | "ios" = "android",
  ): void {
    if (this.monitoredDevices.has(deviceId)) {
      // Update package name if already monitoring this device
      const existing = this.monitoredDevices.get(deviceId)!;
      if (existing.packageName !== packageName) {
        existing.packageName = packageName;
        existing.platform = platform;
        // Reset cached metrics for the new package
        existing.cachedCpu = null;
        existing.cachedMemory = null;
        existing.cachedFps = null;
        existing.cachedFrameTime = null;
        existing.cachedTouchLatency = null;
        existing.cachedPid = null;
        existing.lastMediumTick = 0;
        existing.lastSlowTick = 0;
        existing.prevJankCounters = null;
        existing.previousCpuSample = null;
        existing.gfxPrimed = false;
        // Bump the generation so any A→B→A in-flight sample is rejected even
        // though the package name matches again.
        existing.monitoringGeneration += 1;
        // Drop the previous app's windowed samples so the next observe snapshot
        // cannot attribute app A's fps/cpu/memory to app B (buffer is keyed by
        // deviceId, so a package switch must reset it).
        this.perfWindowBuffer.clear(deviceId);
        this.frameMetricsStore.clear(deviceId);
        logger.info(
          `[PerformanceMonitor] Updated monitoring to ${packageName} on ${deviceId} (${platform})`,
        );
      }
      return;
    }

    this.monitoredDevices.set(deviceId, {
      deviceId,
      packageName,
      monitoringGeneration: 0,
      platform,
      lastFastTick: 0,
      lastMediumTick: 0,
      lastSlowTick: 0,
      cachedCpu: null,
      cachedMemory: null,
      cachedMemoryBreakdown: null,
      cachedFps: null,
      cachedFrameTime: null,
      cachedTouchLatency: null,
      prevJankCounters: null,
      cachedPid: null,
      previousCpuSample: null,
      gfxPrimed: false,
      previousMetricHealth: {},
    });
    logger.info(
      `[PerformanceMonitor] Started monitoring ${packageName} on ${deviceId} (${platform})`,
    );
  }

  /**
   * Stop monitoring a specific device.
   */
  stopMonitoring(deviceId: string): void {
    if (this.monitoredDevices.delete(deviceId)) {
      // Discard retained samples so a later reconnect of the same deviceId
      // cannot surface stale metrics from the prior session.
      this.perfWindowBuffer.clear(deviceId);
      this.frameMetricsStore.clear(deviceId);
      logger.info(`[PerformanceMonitor] Stopped monitoring ${deviceId}`);
    }
  }

  /**
   * Check if a device is currently being monitored.
   */
  isMonitoring(deviceId: string): boolean {
    return this.monitoredDevices.has(deviceId);
  }

  /**
   * True if an in-flight sample still belongs to the currently-monitored app:
   * the same `MonitoredDevice` object is registered for its id AND its package
   * has not switched since sampling began. Async collection can outlive a
   * package switch or `stopMonitoring()`, and such a stale sample must not touch
   * the current device's caches, stream, or buffer.
   */
  private isSampleCurrent(
    device: MonitoredDevice,
    samplingPackage: string,
    samplingGeneration: number,
  ): boolean {
    return (
      this.monitoredDevices.get(device.deviceId) === device &&
      device.packageName === samplingPackage &&
      device.monitoringGeneration === samplingGeneration
    );
  }

  /**
   * Get the number of devices currently being monitored.
   */
  getMonitoredDeviceCount(): number {
    return this.monitoredDevices.size;
  }

  /**
   * Trigger a sampling tick. Prevents concurrent execution.
   */
  private async trigger(): Promise<void> {
    if (this.pending) {
      return this.pending;
    }

    this.pending = this.tick().finally(() => {
      this.pending = null;
    });

    return this.pending;
  }

  /**
   * Execute one sampling tick across all monitored devices.
   */
  private async tick(): Promise<void> {
    const server = this.getServer();
    if (!server) {
      return;
    }

    if (this.monitoredDevices.size === 0) {
      return;
    }

    const now = this.timer.now();
    const promises: Promise<void>[] = [];

    for (const device of this.monitoredDevices.values()) {
      promises.push(this.sampleDevice(device, now, server));
    }

    await Promise.all(promises);
  }

  /**
   * Sample metrics for a single device based on interval tiers.
   */
  private async sampleDevice(
    device: MonitoredDevice,
    now: number,
    server: PerformanceDataPusher,
  ): Promise<void> {
    try {
      if (device.platform === "ios") {
        await this.sampleIOSDevice(device, now, server);
      } else {
        await this.sampleAndroidDevice(device, now, server);
      }
    } catch (error) {
      logger.debug(`[PerformanceMonitor] Error sampling ${device.deviceId}: ${error}`);
    }
  }

  /**
   * Sample metrics for an Android device.
   */
  private async sampleAndroidDevice(
    device: MonitoredDevice,
    now: number,
    server: PerformanceDataPusher,
  ): Promise<void> {
    // Identity captured before any await: if the monitored package switches (or
    // monitoring stops) while these adb calls are in flight, this whole sample
    // belongs to the old app and must not touch the current device's caches,
    // stream, or buffer.
    const samplingPackage = device.packageName;
    const samplingGeneration = device.monitoringGeneration;

    // Prefer real per-frame data from the in-app SDK when it is fresh (issue
    // #5076): it measures the app's own rendering, so we skip the dumpsys frame
    // scrape entirely this tick and fall back to gfxinfo only when no fresh SDK
    // sample exists (non-SDK app or a quiet feed).
    const sdkFrame = this.frameMetricsStore.getFresh(
      device.deviceId,
      samplingPackage,
      now,
      PerformanceMonitor.SDK_FRAME_TTL_MS,
    );

    const gfxPromise = sdkFrame ? Promise.resolve(null) : this.collectGfxMetrics(device);

    // Collect medium metrics (CPU) if interval elapsed or first collection. The
    // collect calls do NOT mutate `device` — caches/timestamps are updated only
    // after the post-await identity check below.
    const shouldCollectCpu =
      device.lastMediumTick === 0 ||
      now - device.lastMediumTick >= PerformanceMonitor.MEDIUM_INTERVAL_MS;
    const cpuPromise = shouldCollectCpu
      ? this.collectCpuMetrics(device)
      : Promise.resolve({ cpuUsagePercent: device.cachedCpu, sample: null });

    // Collect slow metrics (memory) if interval elapsed or first collection
    const shouldCollectMemory =
      device.lastSlowTick === 0 || now - device.lastSlowTick >= PerformanceMonitor.SLOW_INTERVAL_MS;
    const memoryPromise = shouldCollectMemory
      ? this.collectMemoryMetrics(device)
      : Promise.resolve({
          totalPssMb: device.cachedMemory,
          breakdown: device.cachedMemoryBreakdown,
        });

    const [gfx, cpuResult, memResult] = await Promise.all([gfxPromise, cpuPromise, memoryPromise]);
    const cpu = cpuResult.cpuUsagePercent;
    const memory = memResult.totalPssMb;
    const memoryBreakdown = memResult.breakdown;

    // Drop the whole sample if monitoring changed apps or stopped mid-collection.
    if (!this.isSampleCurrent(device, samplingPackage, samplingGeneration)) {
      return;
    }

    device.lastFastTick = now;
    if (shouldCollectCpu) {
      device.lastMediumTick = now;
      device.cachedCpu = cpu;
      // Keep the last valid baseline across transient collection failures so the
      // next successful sample can still measure the full interval.
      if (cpuResult.sample) {
        device.previousCpuSample = cpuResult.sample;
      }
    }
    if (shouldCollectMemory) {
      device.lastSlowTick = now;
      device.cachedMemory = memory;
      device.cachedMemoryBreakdown = memoryBreakdown;
    }

    // Resolve fps / frame time / jank / touch latency from whichever source is
    // active this tick. `rawFps`/`rawFrameTimeMs`/`rawTouchLatencyMs` feed the
    // windowed buffer (null when there is genuinely no in-window reading); the
    // stream values use cached fallbacks to avoid flicker to 0.
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

      const touch = this.estimateTouchLatency(gfxData, frameTimeMs, device);
      touchLatencyMs = touch.streamMs;
      rawTouchLatencyMs = touch.rawMs;
      rawFps = gfxData.fps;
      rawFrameTimeMs = gfxData.frameTimeMs;
    }

    // The first gfxinfo read is cumulative since app launch rather than since
    // monitoring started. Keep it for the live stream, but do not let it seed
    // the windowed snapshot. SDK samples are already interval-scoped.
    const recordGfxWindowSample = this.consumeGfxPriming(
      device,
      sdkFrame,
      gfx?.resetSucceeded ?? false,
    );

    // Get TTI from the global store if available
    const ttiMs = getLastTtiMs(device.packageName);

    const metrics = {
      fps,
      frameTimeMs,
      jankFrames,
      touchLatencyMs,
      ttffMs: null,
      ttiMs,
      cpuUsagePercent: cpu,
      memoryUsageMb: memory,
    };

    // Raw per-interval frame readings (null when no frames rendered this tick)
    // for the windowed buffer. The stream uses the cached fps/frameTime to avoid
    // flicker to 0, but the buffer must NOT re-record a stale reading every idle
    // tick — that would keep an old fps dominating the percentiles.
    this.pushMetrics(device, now, metrics, jankFrames, server, {
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
    });
  }

  /**
   * Estimate Android touch latency from the interval's frame stats. Returns the
   * stream value (a fabricated 16ms when the app is idle so the live gauge stays
   * responsive) and the raw value (null when idle, so the windowed buffer records
   * only genuine measurements). "High input latency" frames scale the estimate
   * from ~2x frame time (a few) to ~4x (many).
   */
  private estimateTouchLatency(
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

  /**
   * Sample metrics for an iOS device.
   * iOS metrics are limited compared to Android:
   * - FPS/frame time: Not available without in-app SDK
   * - CPU/Memory: Available via simctl spawn
   */
  private async sampleIOSDevice(
    device: MonitoredDevice,
    now: number,
    server: PerformanceDataPusher,
  ): Promise<void> {
    // Identity captured before any await (see sampleAndroidDevice).
    const samplingPackage = device.packageName;
    const samplingGeneration = device.monitoringGeneration;

    // Collect metrics without mutating `device`; caches update only after the
    // post-await identity check (see sampleAndroidDevice).
    const shouldCollectCpu =
      device.lastMediumTick === 0 ||
      now - device.lastMediumTick >= PerformanceMonitor.MEDIUM_INTERVAL_MS;
    const cpuPromise = shouldCollectCpu
      ? this.collectIOSCpuMetrics(device)
      : Promise.resolve(device.cachedCpu);

    // Collect slow metrics (memory) if interval elapsed or first collection
    const shouldCollectMemory =
      device.lastSlowTick === 0 || now - device.lastSlowTick >= PerformanceMonitor.SLOW_INTERVAL_MS;
    const memoryPromise = shouldCollectMemory
      ? this.collectIOSMemoryMetrics(device)
      : Promise.resolve(device.cachedMemory);

    const [cpu, memory] = await Promise.all([cpuPromise, memoryPromise]);

    if (!this.isSampleCurrent(device, samplingPackage, samplingGeneration)) {
      return;
    }

    device.lastFastTick = now;
    if (shouldCollectCpu) {
      device.lastMediumTick = now;
      device.cachedCpu = cpu;
    }
    if (shouldCollectMemory) {
      device.lastSlowTick = now;
      device.cachedMemory = memory;
    }

    // iOS doesn't provide FPS/frame time metrics without in-app SDK
    // We report null to indicate "not available" rather than assuming values
    const fps: number | null = null;
    const frameTimeMs: number | null = null;
    const jankFrames: number | null = null;
    const touchLatencyMs: number | null = null;

    // Get TTI from the global store if available
    const ttiMs = getLastTtiMs(device.packageName);

    const metrics = {
      fps,
      frameTimeMs,
      jankFrames,
      touchLatencyMs,
      ttffMs: null,
      ttiMs,
      cpuUsagePercent: cpu,
      memoryUsageMb: memory,
    };

    // iOS has no on-device frame/touch source here, so raw readings are null.
    // Host `ps` yields only RSS, not a meminfo-style component breakdown.
    this.pushMetrics(device, now, metrics, jankFrames, server, {
      fps,
      frameTimeMs,
      jankFrames: null,
      touchLatencyMs: null,
      cpuUsagePercent: shouldCollectCpu ? cpu : null,
      memoryUsageMb: shouldCollectMemory ? memory : null,
      frameTimePercentilesMs: null,
      memoryBreakdownMb: null,
    });
  }

  /**
   * Push metrics to both the performance server and observation stream.
   */
  private pushMetrics(
    device: MonitoredDevice,
    now: number,
    metrics: {
      fps: number | null;
      frameTimeMs: number | null;
      jankFrames: number | null;
      touchLatencyMs: number | null;
      ttffMs: number | null;
      ttiMs: number | null;
      cpuUsagePercent: number | null;
      memoryUsageMb: number | null;
    },
    jankFrames: number | null,
    server: PerformanceDataPusher,
    // Raw per-interval readings for the windowed buffer only (null on an idle
    // no-frame tick), kept separate from the cached/fabricated stream values.
    // Callers guarantee (via isSampleCurrent) that the sample still belongs to
    // the currently-monitored app before calling.
    raw: {
      fps: number | null;
      frameTimeMs: number | null;
      jankFrames: number | null;
      touchLatencyMs: number | null;
      cpuUsagePercent: number | null;
      memoryUsageMb: number | null;
      frameTimePercentilesMs: FrameTimePercentiles | null;
      memoryBreakdownMb: MemoryBreakdownMb | null;
    },
  ): void {
    const data: LivePerformanceData = {
      deviceId: device.deviceId,
      // Resolved by the push server from deviceId at push time (epic #5256, item 3).
      deviceSessionUuid: null,
      packageName: device.packageName,
      timestamp: now,
      nodeId: null,
      screenName: null,
      metrics,
      thresholds: DEFAULT_THRESHOLDS,
      health: PerformancePushSocketServer.calculateHealth(metrics, DEFAULT_THRESHOLDS),
    };

    server.pushPerformanceData(data);

    // Feed the windowed buffer at this single fan-out point so both Android
    // (dumpsys) and iOS (host CPU/mem) samples land in the observe snapshot.
    // Frame/touch fields use the RAW per-interval readings so idle no-frame
    // ticks stay null and don't pin a stale reading in the window.
    this.perfWindowBuffer.record(device.deviceId, {
      t: now,
      fps: raw.fps,
      frameTimeMs: raw.frameTimeMs,
      jankFrames: raw.jankFrames,
      touchLatencyMs: raw.touchLatencyMs,
      cpuUsagePercent: raw.cpuUsagePercent,
      memoryUsageMb: raw.memoryUsageMb,
      frameTimePercentilesMs: raw.frameTimePercentilesMs,
      memoryBreakdownMb: raw.memoryBreakdownMb,
    });

    // Emit telemetry events when metric health status changes
    this.emitPerformanceTelemetry(device, now, metrics, data.health);

    // Also push to the observation stream for IDE plugin
    // Skip for iOS - CtrlProxy iOSClient handles observation stream updates via CADisplayLink
    if (device.platform === "ios") {
      return;
    }

    const observationServer = getDeviceDataStreamServer();
    if (observationServer) {
      const recompositionSummary = RecompositionTracker.getInstance().getLatestSummary(
        device.deviceId,
        device.packageName,
      );
      const streamData: PerformanceStreamData = {
        fps: metrics.fps ?? 0,
        frameTimeMs: metrics.frameTimeMs ?? 0,
        jankFrames: jankFrames ?? 0,
        droppedFrames: 0, // Not tracked in real-time monitoring
        memoryUsageMb: metrics.memoryUsageMb ?? 0,
        cpuUsagePercent: metrics.cpuUsagePercent ?? 0,
        touchLatencyMs: metrics.touchLatencyMs,
        timeToInteractiveMs: metrics.ttiMs,
        screenName: null, // Could be enhanced with current activity
        isResponsive: data.health !== "critical",
        recompositionCount: recompositionSummary?.totalRecompositions ?? null,
        recompositionRate: recompositionSummary?.averagePerSecond ?? null,
      };
      observationServer.pushPerformanceUpdate(device.deviceId, streamData);
    }
  }

  private consumeGfxPriming(
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

  /**
   * Detect per-metric health changes and emit telemetry events.
   * Only emits when a metric crosses a threshold boundary (healthy→warning→critical or back).
   */
  private emitPerformanceTelemetry(
    device: MonitoredDevice,
    now: number,
    metrics: {
      fps: number | null;
      frameTimeMs: number | null;
      jankFrames: number | null;
      touchLatencyMs: number | null;
      memoryUsageMb: number | null;
      cpuUsagePercent: number | null;
    },
    overallHealth: string,
  ): void {
    const th = DEFAULT_THRESHOLDS;
    const currentHealth: Record<string, string> = {};
    const changedMetrics: string[] = [];

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
      currentHealth.frameTime =
        metrics.frameTimeMs > th.frameTimeCritical
          ? "critical"
          : metrics.frameTimeMs > th.frameTimeWarning
            ? "warning"
            : "healthy";
    }
    if (metrics.jankFrames !== null) {
      currentHealth.jank =
        metrics.jankFrames > th.jankCritical
          ? "critical"
          : metrics.jankFrames > th.jankWarning
            ? "warning"
            : "healthy";
    }
    if (metrics.touchLatencyMs !== null) {
      currentHealth.touchLatency =
        metrics.touchLatencyMs > th.touchLatencyCritical
          ? "critical"
          : metrics.touchLatencyMs > th.touchLatencyWarning
            ? "warning"
            : "healthy";
    }
    if (metrics.memoryUsageMb !== null) {
      // Classify memory into bands — emit telemetry when band changes.
      // Thresholds based on typical Android app memory budgets.
      const mb = metrics.memoryUsageMb;
      currentHealth.memory = mb > 300 ? "critical" : mb > 200 ? "warning" : "healthy";
    }

    // Compare against previous health — emit when any metric crosses a threshold
    const isFirstSample = Object.keys(device.previousMetricHealth).length === 0;
    for (const [metric, health] of Object.entries(currentHealth)) {
      const prev = device.previousMetricHealth[metric];
      if (prev !== undefined && prev !== health) {
        changedMetrics.push(metric);
      }
    }

    // Update stored health
    device.previousMetricHealth = currentHealth;

    // Emit on first sample (baseline) or when any metric health changed
    const effectiveChanged = isFirstSample
      ? Object.keys(currentHealth) // all metrics for baseline
      : changedMetrics;

    if (effectiveChanged.length > 0) {
      const emitter = this.getTelemetryEmitter();
      emitter.setContext(device.deviceId, null);
      emitter.recordPerformanceEvent({
        timestamp: now,
        packageName: device.packageName,
        fps: metrics.fps,
        frameTimeMs: metrics.frameTimeMs,
        jankFrames: metrics.jankFrames,
        touchLatencyMs: metrics.touchLatencyMs,
        memoryUsageMb: metrics.memoryUsageMb,
        cpuUsagePercent: metrics.cpuUsagePercent,
        health: overallHealth,
        changedMetrics: effectiveChanged,
      });
    }
  }

  /**
   * Collect graphics metrics from dumpsys gfxinfo.
   * Parses FPS, frame time percentiles, and raw jank counters.
   * Resets gfxinfo after reading to get fresh data for the next interval.
   * Jank delta calculation happens in sampleDevice.
   */
  private async collectGfxMetrics(
    device: MonitoredDevice,
  ): Promise<GfxMetrics & { rawJankCounters: RawJankCounters | null; resetSucceeded: boolean }> {
    try {
      const adb = this.adbClientFactory.create({
        deviceId: device.deviceId,
        name: device.deviceId,
        platform: "android",
      });

      // Read and reset gfxinfo in one command to get fresh interval data
      // The 'reset' flag clears stats after reading, so next read reflects only new frames
      const { stdout } = await adb.executeCommand(
        `shell dumpsys gfxinfo ${device.packageName} reset`,
      );

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
      const deadlineMissed = parseInt(
        stdout.match(/Frame deadline missed:\s+(\d+)/)?.[1] || "0",
        10,
      );
      // Aggregate janky-frame count (deduplicated across causes) when present.
      const jankyMatch = stdout.match(/Janky frames:\s+(\d+)/);
      const jankyFrames = jankyMatch ? parseInt(jankyMatch[1], 10) : null;

      // Parse high input latency frame count
      const highInputLatencyMatch = stdout.match(/Number High input latency:\s+(\d+)/);
      const highInputLatencyFrames = highInputLatencyMatch
        ? parseInt(highInputLatencyMatch[1], 10)
        : null;

      // Calculate FPS from frame time
      const fps = frameTimeMs && frameTimeMs > 0 ? Math.min(1000 / frameTimeMs, 60) : null;

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
    } catch (error) {
      logger.debug(`[PerformanceMonitor] gfxinfo failed for ${device.deviceId}: ${error}`);
      return {
        fps: null,
        frameTimeMs: null,
        jankFrames: null,
        highInputLatencyFrames: null,
        totalFrames: null,
        frameTimePercentilesMs: null,
        rawJankCounters: null,
        resetSucceeded: false,
      };
    }
  }

  /**
   * Collect CPU usage from /proc/{pid}/stat and /proc/uptime.
   * Returns the interval percentage and the sample used as the next baseline.
   */
  private async collectCpuMetrics(device: MonitoredDevice): Promise<CpuMetricsResult> {
    try {
      const adb = this.adbClientFactory.create({
        deviceId: device.deviceId,
        name: device.deviceId,
        platform: "android",
      });

      // Get the process ID
      const { stdout: pidOut } = await adb.executeCommand(`shell pidof ${device.packageName}`);
      const pid = pidOut.trim().split(/\s+/)[0]; // Take first PID if multiple
      if (!pid) {
        return { cpuUsagePercent: null, sample: null };
      }

      // Get CPU stats from /proc/stat
      const { stdout: statOut } = await adb.executeCommand(`shell cat /proc/${pid}/stat`);
      const fields = statOut.split(" ");
      const utime = parseInt(fields[13] || "0", 10);
      const stime = parseInt(fields[14] || "0", 10);

      // Get system uptime
      const { stdout: uptimeOut } = await adb.executeCommand("shell cat /proc/uptime");
      const uptime = parseFloat(uptimeOut.split(" ")[0] || "0");

      const processTicks = utime + stime;
      if (!Number.isFinite(processTicks) || !Number.isFinite(uptime) || uptime <= 0) {
        return { cpuUsagePercent: null, sample: null };
      }

      const sample = { processTicks, uptimeSeconds: uptime };
      const previous = device.previousCpuSample;
      if (!previous) {
        return { cpuUsagePercent: null, sample };
      }

      const processTickDelta = processTicks - previous.processTicks;
      const uptimeDelta = uptime - previous.uptimeSeconds;
      if (processTickDelta < 0 || uptimeDelta <= 0) {
        return { cpuUsagePercent: null, sample };
      }

      // Android reports process CPU time in clock ticks; 100 ticks represent one
      // second on the supported devices. Calculate usage over the sampling interval.
      const cpuPercent = (processTickDelta / (uptimeDelta * 100)) * 100;
      return { cpuUsagePercent: Math.min(cpuPercent, 100), sample };
    } catch (error) {
      logger.debug(`[PerformanceMonitor] CPU metrics failed for ${device.deviceId}: ${error}`);
      return { cpuUsagePercent: null, sample: null };
    }
  }

  /**
   * Collect memory usage from `dumpsys meminfo`. Returns total PSS in MB plus
   * the App Summary per-component breakdown.
   *
   * We read the full `dumpsys meminfo` output rather than piping through
   * `grep "TOTAL PSS"`: the App Summary breakdown (Java heap, native heap, etc.)
   * is already computed by the same dumpsys pass — dropping the on-device grep
   * transfers a few more KB but adds no work on the target. We deliberately do
   * NOT pass `--unreachable`, which would force a GC on the target process.
   */
  private async collectMemoryMetrics(
    device: MonitoredDevice,
  ): Promise<{ totalPssMb: number | null; breakdown: MemoryBreakdownMb | null }> {
    try {
      const adb = this.adbClientFactory.create({
        deviceId: device.deviceId,
        name: device.deviceId,
        platform: "android",
      });

      const { stdout } = await adb.executeCommand(`shell dumpsys meminfo ${device.packageName}`);

      // App Summary "TOTAL PSS:" line (present since API 21).
      const totalMatch = stdout.match(/TOTAL PSS:\s+(\d+)/);
      const totalPssMb = totalMatch ? parseInt(totalMatch[1], 10) / 1024 : null;

      return { totalPssMb, breakdown: parseMemoryBreakdown(stdout) };
    } catch (error) {
      logger.debug(`[PerformanceMonitor] Memory metrics failed for ${device.deviceId}: ${error}`);
      return { totalPssMb: null, breakdown: null };
    }
  }

  /**
   * Resolve the host `ps aux` columns for a simulator app process, scoped to a
   * single simulator.
   *
   * iOS Simulator apps run as ordinary macOS processes whose command line is the
   * app binary under `.../CoreSimulator/Devices/<UDID>/data/...`, so the device
   * UDID is always present in the process line. Matching on the bundle id alone
   * (the previous behavior) picked the *first* process on the host, so when the
   * same bundle runs on two booted simulators both device-keyed snapshots
   * received the first match's metrics (#5109). Requiring both the device's
   * UDID (`device.deviceId`) and the bundle id in the same line scopes the match
   * to this simulator. For a single simulator this is behavior-identical — the
   * one matching line already contains its own UDID.
   *
   * Returns the whitespace-split `ps aux` columns of the matching line, or null
   * when no process for this device+bundle is found. Caches the resolved PID.
   */
  private async resolveIOSProcessColumns(device: MonitoredDevice): Promise<string[] | null> {
    // Run ps on the HOST (not inside simulator) to find the app process.
    const { stdout } = await this.execFileAsync("ps", ["aux"]);

    const lines = stdout.split("\n");
    for (const line of lines) {
      // Scope to this simulator: the command line carries both the device UDID
      // (in the CoreSimulator data-container path) and the bundle id.
      if (line.includes(device.deviceId) && line.includes(device.packageName)) {
        // ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
        const parts = line.trim().split(/\s+/);
        const pid = parseInt(parts[1], 10);
        if (!isNaN(pid) && pid > 0) {
          device.cachedPid = pid;
        }
        return parts;
      }
    }

    return null;
  }

  /**
   * Collect CPU usage for an iOS app.
   * iOS Simulator apps run as macOS processes, so we use `ps` on the host,
   * scoped to this simulator's UDID (see resolveIOSProcessColumns).
   */
  private async collectIOSCpuMetrics(device: MonitoredDevice): Promise<number | null> {
    try {
      const parts = await this.resolveIOSProcessColumns(device);
      if (!parts) {
        return null;
      }
      const cpuPercent = parseFloat(parts[2]);
      if (isNaN(cpuPercent)) {
        return null;
      }
      return Math.min(cpuPercent, 100); // Cap at 100%
    } catch (error) {
      logger.debug(`[PerformanceMonitor] iOS CPU metrics failed for ${device.deviceId}: ${error}`);
      return null;
    }
  }

  /**
   * Collect memory usage for an iOS app.
   * iOS Simulator apps run as macOS processes, so we use `ps` on the host,
   * scoped to this simulator's UDID (see resolveIOSProcessColumns).
   * Returns RSS (Resident Set Size) in megabytes.
   */
  private async collectIOSMemoryMetrics(device: MonitoredDevice): Promise<number | null> {
    try {
      const parts = await this.resolveIOSProcessColumns(device);
      if (!parts) {
        return null;
      }
      // RSS is in KB on macOS.
      const rssKb = parseInt(parts[5], 10);
      if (isNaN(rssKb)) {
        return null;
      }
      return rssKb / 1024; // Convert to MB
    } catch (error) {
      logger.debug(
        `[PerformanceMonitor] iOS memory metrics failed for ${device.deviceId}: ${error}`,
      );
      return null;
    }
  }
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

/**
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

// TTI (Time to Interactive) store - tracks last known TTI per package
// TTI is an event-based metric captured at app launch, not continuous
const ttiStore = new Map<string, { ttiMs: number; timestamp: number }>();

/** Startup timing is only relevant for recent launches (within 5 minutes). */
const STARTUP_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Store the last known TTI for a package.
 * Called by LaunchApp after measuring displayed time.
 */
export function setLastTtiMs(packageName: string, ttiMs: number): void {
  ttiStore.set(packageName, { ttiMs, timestamp: defaultTimer.now() });
  logger.debug(`[PerformanceMonitor] Stored TTI for ${packageName}: ${ttiMs}ms`);
}

/**
 * Get the last known TTI for a package.
 * Returns null if no TTI has been recorded or if it's stale (>5 minutes old).
 */
function getLastTtiMs(packageName: string): number | null {
  const entry = ttiStore.get(packageName);
  if (!entry) {
    return null;
  }
  if (defaultTimer.now() - entry.timestamp > STARTUP_MAX_AGE_MS) {
    ttiStore.delete(packageName);
    return null;
  }
  return entry.ttiMs;
}

/**
 * Startup timing for a package's most recent launch, for the observe
 * `perfSnapshot`. Reads the same in-memory launch cache as {@link getLastTtiMs}
 * (populated by `launchApp` from the ActivityManager "Displayed" time), so it
 * adds no device work. Returns null when no launch is recorded or the last one
 * is stale (>5 minutes).
 */
export function getLastStartupTimingMs(packageName: string): StartupTimingSummary | null {
  const entry = ttiStore.get(packageName);
  if (!entry) {
    return null;
  }
  const ageMs = defaultTimer.now() - entry.timestamp;
  if (ageMs > STARTUP_MAX_AGE_MS) {
    ttiStore.delete(packageName);
    return null;
  }
  return { displayedMs: entry.ttiMs, ageMs };
}

// Singleton instance
let monitorInstance: PerformanceMonitor | null = null;

/**
 * Get the singleton PerformanceMonitor instance.
 */
export function getPerformanceMonitor(): PerformanceMonitor {
  if (!monitorInstance) {
    monitorInstance = new PerformanceMonitor();
  }
  return monitorInstance;
}

/**
 * Start the performance monitor.
 */
export function startPerformanceMonitor(): void {
  getPerformanceMonitor().start();
}

/**
 * Stop the performance monitor.
 */
export function stopPerformanceMonitor(): void {
  if (monitorInstance) {
    monitorInstance.stop();
  }
}

// Export for testing
export function _resetPerformanceMonitor(): void {
  if (monitorInstance) {
    monitorInstance.stop();
  }
  monitorInstance = null;
}
