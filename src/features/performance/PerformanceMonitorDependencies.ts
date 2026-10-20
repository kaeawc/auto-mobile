import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { PerfWindowBuffer } from "./PerfWindowBuffer";
import type {
  ExecFileAsyncFn,
  PerformanceTelemetryEmitter,
  ServerGetter,
  SimCtlClientFactory,
} from "./PerformanceMonitor";
import type { PerformanceDemandProbe } from "./PerformanceMonitorTypes";
import type { SdkFrameMetricsStore } from "./SdkFrameMetricsStore";

/** Optional collaborators for {@link PerformanceMonitor}; the singleton wires production demand. */
export interface PerformanceMonitorDependencies {
  adbClientFactory?: AdbClientFactory;
  serverGetter?: ServerGetter;
  simCtlClientFactory?: SimCtlClientFactory;
  execFileAsync?: ExecFileAsyncFn;
  getTelemetryEmitter?: () => PerformanceTelemetryEmitter;
  perfWindowBuffer?: PerfWindowBuffer;
  frameMetricsStore?: SdkFrameMetricsStore;
  /** Defaults to always sampling for direct construction; getPerformanceMonitor wires daemon demand. */
  demandProbe?: PerformanceDemandProbe;
}
