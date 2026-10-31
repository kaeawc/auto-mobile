import { createDaemonPerformanceDemandProbe } from "./PerformanceDemandProbe";
import {
  alwaysSample,
  PerformanceSamplingDemand,
  resetSamplingBaselines,
} from "./PerformanceSamplingDemand";
import { PS_SNAPSHOT_ARGS } from "../../devices/bootAdmission/psSnapshot";
import {
  collectIOSPerformanceMetrics,
  createIOSPerformanceProcessResolver,
  type IOSPerformanceProcessResolver,
} from "./iosPerformanceProcessSnapshot";
import { defaultExecFileAsync, defaultSimCtlClientFactory } from "./PerformanceMonitorDefaults";
export { defaultSimCtlClientFactory } from "./PerformanceMonitorDefaults";
import {
  getDeviceDataStreamServer,
  PerformanceStreamData,
} from "../../daemon/deviceDataStreamSocketServer";
import {
  DEFAULT_THRESHOLDS,
  getPerformancePushServer,
  LivePerformanceData,
  PerformancePushSocketServer,
} from "../../daemon/performancePushSocketServer";
import type { FrameTimePercentiles, MemoryBreakdownMb } from "../../models/PerfSnapshot";

import { defaultTimer, Timer } from "../../utils/SystemTimer";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { registerDeviceIncarnationListener } from "../../utils/deviceIncarnation";
import { logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shellQuote";
import { TelemetryRecorder } from "../telemetry/TelemetryRecorder";

import { getPerfWindowBuffer, PerfWindowBuffer } from "./PerfWindowBuffer";
import type { PerformanceMonitorDependencies } from "./PerformanceMonitorDependencies";
import {
  CpuMetricsResult,
  ExecFileAsyncFn,
  MonitoredDevice,
  PerformanceDataPusher,
  PerformanceTelemetryEmitter,
  ServerGetter,
  SimCtlClientFactory,
} from "./PerformanceMonitorTypes";
import { RecompositionTracker } from "./RecompositionTracker";
import { getSdkFrameMetricsStore, SdkFrameMetricsStore } from "./SdkFrameMetricsStore";
import type { GfxMetrics, RawJankCounters } from "./performanceMetricAnalysis";
import {
  classifyMetricHealth,
  consumeGfxPriming,
  createAndroidWindowSample,
  parseGfxMetrics,
  parseMemoryBreakdown,
  resolveAndroidFrameMetrics,
} from "./performanceMetricAnalysis";
import { getLastTtiMs, ttiStore } from "./performanceStartupTiming";
export {
  type ExecFileAsyncFn,
  type MonitoredDevice,
  type PerformanceDataPusher,
  type PerformanceSamplingCoordinator,
  type PerformanceTelemetryEmitter,
  type ServerGetter,
  type SimCtlClientFactory,
} from "./PerformanceMonitorTypes";
export { getLastStartupTimingMs, setLastTtiMs } from "./performanceStartupTiming";

/**
 * Samples registered devices only while subscribers or a five-minute observe
 * perf-window lease need data. Production demand is wired by getPerformanceMonitor;
 * direct construction defaults to always sampling for existing callers/tests.
 * Demanded devices retain the 500ms graphics, 2s CPU and 10s memory tiers.
 */
export class PerformanceMonitor {
  static readonly TICK_INTERVAL_MS = 500;
  static readonly MEDIUM_INTERVAL_MS = 2000;
  static readonly SLOW_INTERVAL_MS = 10000;
  /**
   * A background sample must never own the ADB lane indefinitely. This is
   * intentionally longer than the sampling cadence: overlapping ticks are
   * already suppressed, while a wedged device command is released promptly.
   */
  static readonly ANDROID_COMMAND_TIMEOUT_MS = 2000;
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
  private readonly samplingDemand: PerformanceSamplingDemand;
  private monitoredDevices = new Map<string, MonitoredDevice>();
  private readonly pausedDeviceCounts = new Map<string, number>();
  private readonly activeAndroidSamples = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();

  constructor(timer: Timer = defaultTimer, dependencies: PerformanceMonitorDependencies = {}) {
    const {
      adbClientFactory = defaultAdbClientFactory,
      serverGetter = getPerformancePushServer,
      simCtlClientFactory = defaultSimCtlClientFactory,
      execFileAsync = defaultExecFileAsync,
      getTelemetryEmitter = () => TelemetryRecorder.getInstance(),
      perfWindowBuffer = getPerfWindowBuffer(),
      frameMetricsStore = getSdkFrameMetricsStore(),
      demandProbe = alwaysSample,
    } = dependencies;
    this.timer = timer;
    this.adbClientFactory = adbClientFactory;
    this.simCtlClientFactory = simCtlClientFactory;
    this.getServer = serverGetter;
    this.execFileAsync = execFileAsync;
    this.getTelemetryEmitter = getTelemetryEmitter;
    this.perfWindowBuffer = perfWindowBuffer;
    this.frameMetricsStore = frameMetricsStore;
    this.samplingDemand = new PerformanceSamplingDemand(demandProbe);
  }

  /**
   * Arm the interval when devices are monitored; idle monitors have no timer.
   * Does nothing if already armed.
   */
  start(): void {
    if (this.intervalHandle || this.monitoredDevices.size === 0) {
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
    for (const sample of this.activeAndroidSamples.values()) {
      sample.controller.abort(new Error("Performance monitoring stopped"));
    }
    this.pending = null;
    // Discard every device's retained samples along with the monitored set.
    for (const deviceId of this.monitoredDevices.keys()) {
      this.perfWindowBuffer.clear(deviceId);
      this.frameMetricsStore.clear(deviceId);
    }
    this.samplingDemand.clear();
    this.monitoredDevices.clear();
    this.pausedDeviceCounts.clear();
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
        this.cancelActiveAndroidSample(deviceId, "Monitored package changed");
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

    this.samplingDemand.register(deviceId);
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
    this.start();
    logger.info(
      `[PerformanceMonitor] Started monitoring ${packageName} on ${deviceId} (${platform})`,
    );
  }

  /** Refresh the observe window's five-minute sampling lease. Registration arms the timer. */
  requestPerfWindow(deviceId: string, packageName: string, platform: "android" | "ios"): void {
    this.startMonitoring(deviceId, packageName, platform);
    this.samplingDemand.requestPerfWindow(deviceId, this.timer.now());
  }

  /**
   * Stop monitoring a specific device.
   */
  stopMonitoring(deviceId: string): void {
    this.samplingDemand.remove(deviceId);
    this.cancelActiveAndroidSample(deviceId, "Performance monitoring stopped for device");
    if (this.monitoredDevices.delete(deviceId)) {
      if (this.monitoredDevices.size === 0 && this.intervalHandle) {
        this.timer.clearInterval(this.intervalHandle);
        this.intervalHandle = null;
      }
      // Discard retained samples so a later reconnect of the same deviceId
      // cannot surface stale metrics from the prior session.
      this.perfWindowBuffer.clear(deviceId);
      this.frameMetricsStore.clear(deviceId);
      logger.info(`[PerformanceMonitor] Stopped monitoring ${deviceId}`);
    }
  }

  /**
   * Fence samples already collecting for the prior guest and clear their
   * baselines while retaining the opt-in monitoring subscription. The prior
   * guest's observe lease and dormant marker are dropped too, so the
   * replacement samples only once a consumer or a fresh observe demands it.
   */
  resetDeviceState(deviceId: string): void {
    this.cancelActiveAndroidSample(deviceId, "Device incarnation changed");
    this.samplingDemand.remove(deviceId);
    ttiStore.delete(deviceId);
    const monitored = this.monitoredDevices.get(deviceId);
    if (monitored) {
      const fresh: MonitoredDevice = {
        ...monitored,
        monitoringGeneration: monitored.monitoringGeneration + 1,
        previousMetricHealth: {},
      };
      resetSamplingBaselines(fresh);
      this.monitoredDevices.set(deviceId, fresh);
    }
    this.perfWindowBuffer.clear(deviceId);
    this.frameMetricsStore.clear(deviceId);
  }

  /**
   * Look up the live monitoring record for a device. Public as a test seam so
   * tests can inspect cached samples without reaching into the private map
   * (#11865).
   */
  getMonitoredDevice(deviceId: string): MonitoredDevice | undefined {
    return this.monitoredDevices.get(deviceId);
  }

  /**
   * Check if a device is currently being monitored.
   */
  isMonitoring(deviceId: string): boolean {
    return this.monitoredDevices.has(deviceId);
  }

  async withDeviceSamplingPaused<T>(deviceId: string, operation: () => Promise<T>): Promise<T> {
    this.pausedDeviceCounts.set(deviceId, (this.pausedDeviceCounts.get(deviceId) ?? 0) + 1);
    const activeSample = this.activeAndroidSamples.get(deviceId);
    activeSample?.controller.abort(new Error("Foreground device operation took priority"));
    try {
      await activeSample?.promise;
      return await operation();
    } finally {
      const remaining = (this.pausedDeviceCounts.get(deviceId) ?? 1) - 1;
      if (remaining <= 0) {
        this.pausedDeviceCounts.delete(deviceId);
      } else {
        this.pausedDeviceCounts.set(deviceId, remaining);
      }
    }
  }

  private cancelActiveAndroidSample(deviceId: string, reason: string): void {
    this.activeAndroidSamples.get(deviceId)?.controller.abort(new Error(reason));
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
    const resolveIOSProcess = createIOSPerformanceProcessResolver(() =>
      this.execFileAsync("ps", [...PS_SNAPSHOT_ARGS]),
    );

    for (const device of this.monitoredDevices.values()) {
      if (this.pausedDeviceCounts.has(device.deviceId)) {
        continue;
      }
      if (!this.samplingDemand.shouldSample(device, now)) {
        continue;
      }
      promises.push(this.sampleDevice(device, now, server, resolveIOSProcess));
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
    resolveIOSProcess: IOSPerformanceProcessResolver,
  ): Promise<void> {
    if (device.platform === "android") {
      const controller = new AbortController();
      const promise = this.sampleAndroidDevice(device, now, server, controller.signal)
        .catch((error) => {
          logger.debug(`[PerformanceMonitor] Error sampling ${device.deviceId}: ${error}`);
        })
        .finally(() => {
          if (this.activeAndroidSamples.get(device.deviceId)?.controller === controller) {
            this.activeAndroidSamples.delete(device.deviceId);
          }
        });
      this.activeAndroidSamples.set(device.deviceId, { controller, promise });
      await promise;
      return;
    }
    try {
      await this.sampleIOSDevice(device, now, server, resolveIOSProcess);
    } catch (error) {
      logger.debug(`[PerformanceMonitor] Error sampling ${device.deviceId}: ${error}`);
    }
  }

  /**
   * Sample metrics for an Android device.
   * Public as a test seam (#11865).
   */
  async sampleAndroidDevice(
    device: MonitoredDevice,
    now: number,
    server: PerformanceDataPusher,
    signal: AbortSignal,
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

    const gfxPromise = sdkFrame ? Promise.resolve(null) : this.collectGfxMetrics(device, signal);

    // Collect medium metrics (CPU) if interval elapsed or first collection. The
    // collect calls do NOT mutate `device` — caches/timestamps are updated only
    // after the post-await identity check below.
    const shouldCollectCpu =
      device.lastMediumTick === 0 ||
      now - device.lastMediumTick >= PerformanceMonitor.MEDIUM_INTERVAL_MS;
    const cpuPromise = shouldCollectCpu
      ? this.collectCpuMetrics(device, signal)
      : Promise.resolve({ cpuUsagePercent: device.cachedCpu, sample: null });

    // Collect slow metrics (memory) if interval elapsed or first collection
    const shouldCollectMemory =
      device.lastSlowTick === 0 || now - device.lastSlowTick >= PerformanceMonitor.SLOW_INTERVAL_MS;
    const memoryPromise = shouldCollectMemory
      ? this.collectMemoryMetrics(device, signal)
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
    const frameMetrics = resolveAndroidFrameMetrics(device, sdkFrame, gfx);
    const { fps, frameTimeMs, jankFrames, touchLatencyMs } = frameMetrics;

    // The first gfxinfo read is cumulative since app launch rather than since
    // monitoring started. Keep it for the live stream, but do not let it seed
    // the windowed snapshot. SDK samples are already interval-scoped.
    const recordGfxWindowSample = consumeGfxPriming(device, sdkFrame, gfx?.resetSucceeded ?? false);

    // Get TTI from the global store if available
    const ttiMs = getLastTtiMs(device.deviceId, device.packageName);

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
    this.pushMetrics(device, now, metrics, {
      server,
      raw: createAndroidWindowSample({
        recordGfxWindowSample,
        frameMetrics,
        gfx,
        shouldCollectCpu,
        cpu,
        shouldCollectMemory,
        memory,
        memoryBreakdown,
      }),
    });
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
    resolveIOSProcess: IOSPerformanceProcessResolver,
  ): Promise<void> {
    // Identity captured before any await (see sampleAndroidDevice).
    const samplingPackage = device.packageName;
    const samplingGeneration = device.monitoringGeneration;

    // Collect metrics without mutating `device`; caches update only after the
    // post-await identity check (see sampleAndroidDevice).
    const shouldCollectCpu =
      device.lastMediumTick === 0 ||
      now - device.lastMediumTick >= PerformanceMonitor.MEDIUM_INTERVAL_MS;
    const shouldCollectMemory =
      device.lastSlowTick === 0 || now - device.lastSlowTick >= PerformanceMonitor.SLOW_INTERVAL_MS;
    const { cpu, memory, pid } = await collectIOSPerformanceMetrics(
      device,
      shouldCollectCpu,
      shouldCollectMemory,
      resolveIOSProcess,
    );

    if (!this.isSampleCurrent(device, samplingPackage, samplingGeneration)) {
      return;
    }

    device.cachedPid = pid;
    device.lastFastTick = now;
    if (shouldCollectCpu) {
      device.lastMediumTick = now;
      device.cachedCpu = cpu;
    }
    if (shouldCollectMemory) {
      device.lastSlowTick = now;
      device.cachedMemory = memory;
    }

    // Only the in-app SDK describes app frames; runner CADisplayLink metrics
    // remain excluded. A quiet/non-SDK app has no frame readings.
    const sdkFrame = this.frameMetricsStore.getFresh(
      device.deviceId,
      samplingPackage,
      this.timer.now(),
      PerformanceMonitor.SDK_FRAME_TTL_MS,
    );
    const { fps, frameTimeMs, jankFrames } = sdkFrame ?? {
      fps: null,
      frameTimeMs: null,
      jankFrames: null,
    };
    const touchLatencyMs: number | null = null;

    // Get TTI from the global store if available
    const ttiMs = getLastTtiMs(device.deviceId, device.packageName);

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

    // iOS has no app touch source here; SDK frame readings are already raw.
    // Host `ps` yields only RSS, not a meminfo-style component breakdown.
    this.pushMetrics(device, now, metrics, {
      server,
      raw: {
        fps,
        frameTimeMs,
        jankFrames,
        touchLatencyMs: null,
        cpuUsagePercent: shouldCollectCpu ? cpu : null,
        memoryUsageMb: shouldCollectMemory ? memory : null,
        frameTimePercentilesMs: null,
        memoryBreakdownMb: null,
      },
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
    {
      server,
      raw,
    }: {
      server: PerformanceDataPusher;
      raw: {
        fps: number | null;
        frameTimeMs: number | null;
        jankFrames: number | null;
        touchLatencyMs: number | null;
        cpuUsagePercent: number | null;
        memoryUsageMb: number | null;
        frameTimePercentilesMs: FrameTimePercentiles | null;
        memoryBreakdownMb: MemoryBreakdownMb | null;
      };
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
        jankFrames: metrics.jankFrames ?? 0,
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

  /**
   * Detect per-metric health changes and emit telemetry events.
   * Only emits when a metric crosses a threshold boundary (healthy→warning→critical or back).
   * Public as a test seam (#11865).
   */
  emitPerformanceTelemetry(
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
    const currentHealth = classifyMetricHealth(metrics);
    const changedMetrics: string[] = [];

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
   * Public as a test seam (#11865).
   */
  async collectGfxMetrics(
    device: MonitoredDevice,
    signal: AbortSignal,
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
        `shell dumpsys gfxinfo ${shellQuote(device.packageName)} reset`,
        {
          timeoutMs: PerformanceMonitor.ANDROID_COMMAND_TIMEOUT_MS,
          maxBuffer: DUMPSYS_MAX_BUFFER,
          signal,
          waitForProcessSettlementAfterAbort: true,
        },
      );

      return parseGfxMetrics(stdout);
    } catch (error) {
      signal.throwIfAborted();
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
   * Public as a test seam (#11865).
   */
  async collectCpuMetrics(device: MonitoredDevice, signal: AbortSignal): Promise<CpuMetricsResult> {
    try {
      const adb = this.adbClientFactory.create({
        deviceId: device.deviceId,
        name: device.deviceId,
        platform: "android",
      });

      // Get the process ID
      const { stdout: pidOut } = await adb.executeCommand(
        `shell pidof ${shellQuote(device.packageName)}`,
        {
          timeoutMs: PerformanceMonitor.ANDROID_COMMAND_TIMEOUT_MS,
          signal,
          waitForProcessSettlementAfterAbort: true,
        },
      );
      const pid = pidOut.trim().split(/\s+/)[0]; // Take first PID if multiple
      if (!pid) {
        return { cpuUsagePercent: null, sample: null };
      }

      // Get CPU stats from /proc/stat
      const { stdout: statOut } = await adb.executeCommand(
        `shell cat /proc/${shellQuote(pid)}/stat`,
        {
          timeoutMs: PerformanceMonitor.ANDROID_COMMAND_TIMEOUT_MS,
          signal,
          waitForProcessSettlementAfterAbort: true,
        },
      );
      const fields = statOut
        .slice(statOut.lastIndexOf(")") + 1)
        .trim()
        .split(/\s+/);
      const utime = parseInt(fields[11] || "0", 10);
      const stime = parseInt(fields[12] || "0", 10);

      // Get system uptime
      const { stdout: uptimeOut } = await adb.executeCommand("shell cat /proc/uptime", {
        timeoutMs: PerformanceMonitor.ANDROID_COMMAND_TIMEOUT_MS,
        signal,
        waitForProcessSettlementAfterAbort: true,
      });
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
      signal.throwIfAborted();
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
   * Public as a test seam (#11865).
   */
  async collectMemoryMetrics(
    device: MonitoredDevice,
    signal: AbortSignal,
  ): Promise<{ totalPssMb: number | null; breakdown: MemoryBreakdownMb | null }> {
    try {
      const adb = this.adbClientFactory.create({
        deviceId: device.deviceId,
        name: device.deviceId,
        platform: "android",
      });

      const { stdout } = await adb.executeCommand(
        `shell dumpsys meminfo ${shellQuote(device.packageName)}`,
        {
          timeoutMs: PerformanceMonitor.ANDROID_COMMAND_TIMEOUT_MS,
          maxBuffer: DUMPSYS_MAX_BUFFER,
          signal,
          waitForProcessSettlementAfterAbort: true,
        },
      );

      // App Summary "TOTAL PSS:" line (present since API 21).
      const totalMatch = stdout.match(/TOTAL PSS:\s+(\d+)/);
      const totalPssMb = totalMatch ? parseInt(totalMatch[1], 10) / 1024 : null;

      return { totalPssMb, breakdown: parseMemoryBreakdown(stdout) };
    } catch (error) {
      signal.throwIfAborted();
      logger.debug(`[PerformanceMonitor] Memory metrics failed for ${device.deviceId}: ${error}`);
      return { totalPssMb: null, breakdown: null };
    }
  }
}

// Singleton instance
let monitorInstance: PerformanceMonitor | null = null;

/**
 * Get the singleton PerformanceMonitor instance.
 */
export function getPerformanceMonitor(): PerformanceMonitor {
  if (!monitorInstance) {
    monitorInstance = new PerformanceMonitor(defaultTimer, {
      demandProbe: createDaemonPerformanceDemandProbe(),
    });
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

registerDeviceIncarnationListener({
  name: "performance-monitoring",
  onDeviceIncarnationChanged: (deviceId) => getPerformanceMonitor().resetDeviceState(deviceId),
});
