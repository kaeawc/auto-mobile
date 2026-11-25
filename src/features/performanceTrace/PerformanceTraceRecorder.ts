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
  /** Session that owns the trace; device files a stop could not remove are cleaned on its release. */
  ownerSessionUuid?: string;
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
  /**
   * Whether the recorder has been sent its stop signal (or had already exited). A stop that fails
   * while this is false left the recorder running, so the trace stays registered for a retry.
   */
  readonly signalled: boolean;
  /** Stop the recorder, wait for it to finish writing, and leave the artifact on the host. */
  stop(signal?: AbortSignal): Promise<void>;
  /**
   * End the recorder without keeping its artifact: no pull and no finalisation wait, and what it
   * wrote is deleted. For a start that outlived its session (#18698).
   */
  discard(): Promise<void>;
  /** Read the finished artifact into a bounded summary; failures become warnings. */
  summarize(
    signal?: AbortSignal,
  ): Promise<{ summary: PerformanceTraceSummary; warnings: string[] }>;
}

/** One platform's tracer: `xctrace` on iOS, `perfetto` on Android. */
export interface PerformanceTraceRecorder {
  start(request: StartPerformanceTraceRequest): Promise<RecordingPerformanceTrace>;
}
