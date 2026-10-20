import { LivePerformanceData } from "../../daemon/performancePushSocketServer";
import type { MemoryBreakdownMb } from "../../models/PerfSnapshot";
import { SimCtl } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { TelemetryRecorder } from "../telemetry/TelemetryRecorder";
import type { RawJankCounters } from "./performanceMetricAnalysis";

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

export interface PreviousCpuSample {
  processTicks: number;
  uptimeSeconds: number;
}

export interface CpuMetricsResult {
  cpuUsagePercent: number | null;
  sample: PreviousCpuSample | null;
}

export interface MonitoredDevice {
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

export interface PerformanceSamplingCoordinator {
  withDeviceSamplingPaused<T>(deviceId: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Function type for getting the performance push server.
 */
export type ServerGetter = () => PerformanceDataPusher | null;

/** A live consumer of sampled device/package performance data. */
export interface PerformanceDemandProbe {
  hasDemand(deviceId: string, packageName: string, platform: "android" | "ios"): boolean;
}
