import type { BootedDevice } from "../../models";
import type { ResolvedTraceConfig } from "./perfettoCategoryConfig";
import type { PerformanceTraceTemplate } from "./performanceTraceTemplates";
import type { PerformanceTraceSummary } from "./PerformanceTraceSummary";

interface StartPerformanceTraceBase {
  traceId: string;
  device: BootedDevice;
  appId?: string;
  timeLimitMs: number;
  /** Host directory the finished artifact is written to. */
  artifactDir: string;
  signal?: AbortSignal;
}

/** A trace shaped by a named template (iOS and Android). */
export interface TemplatePerformanceTraceRequest extends StartPerformanceTraceBase {
  template: PerformanceTraceTemplate;
  categoryConfig?: undefined;
}

/** A Perfetto trace shaped by typed categories (Android only); it has no summary. */
export interface CategoryPerformanceTraceRequest extends StartPerformanceTraceBase {
  template?: undefined;
  categoryConfig: ResolvedTraceConfig;
}

export type StartPerformanceTraceRequest =
  | TemplatePerformanceTraceRequest
  | CategoryPerformanceTraceRequest;

/** A recorder that is running (or already stopped itself at its time limit). */
export interface RecordingPerformanceTrace {
  /** Host path of the finished artifact: `.trace` (iOS) or `.perfetto-trace` (Android). */
  readonly artifactPath: string;
  readonly warnings: readonly string[];
  /** Stop the recorder, wait for it to finish writing, and leave the artifact on the host. */
  stop(signal?: AbortSignal): Promise<void>;
  /** Read the finished artifact into a bounded summary; failures become warnings. */
  summarize(
    signal?: AbortSignal,
  ): Promise<{ summary: PerformanceTraceSummary; warnings: string[] }>;
}

/** One platform's tracer: `xctrace` on iOS, `perfetto` on Android. */
export interface PerformanceTraceRecorder {
  start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace>;
}
