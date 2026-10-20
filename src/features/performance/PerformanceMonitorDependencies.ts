import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { PerfWindowBuffer } from "./PerfWindowBuffer";
import type {
  ExecFileAsyncFn,
  PerformanceTelemetryEmitter,
  ServerGetter,
  SimCtlClientFactory,
} from "./PerformanceMonitor";
import type { SdkFrameMetricsStore } from "./SdkFrameMetricsStore";

/** Optional collaborators for {@link PerformanceMonitor}; each defaults to the production one. */
export interface PerformanceMonitorDependencies {
  adbClientFactory?: AdbClientFactory;
  serverGetter?: ServerGetter;
  simCtlClientFactory?: SimCtlClientFactory;
  execFileAsync?: ExecFileAsyncFn;
  getTelemetryEmitter?: () => PerformanceTelemetryEmitter;
  perfWindowBuffer?: PerfWindowBuffer;
  frameMetricsStore?: SdkFrameMetricsStore;
}

/**
 * Continuous performance monitor that samples device metrics at tiered intervals
 * and pushes them to the IDE via PerformancePushSocketServer.
 *
 * Sampling tiers:
 * - Fast (500ms): FPS, frame time, jank count via dumpsys gfxinfo
 * - Medium (2s): CPU usage via /proc/{pid}/stat
 * - Slow (10s): Memory usage via dumpsys meminfo
 */
