import type { IosScreenCaptureReadinessPhase } from "../screen-stream";
import {
  NATIVE_FRAME_METRICS_PREFIX,
  SIMULATOR_IDLE_EVIDENCE_CAPABILITY,
  type CapturePermission,
} from "../screen-stream/IosScreenCaptureHelper";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { IosFramePipeline } from "./IosFramePipeline";
import { isHelperError } from "./IosCaptureStartup";
import type { IosFrameCaptureHelper, IosH264SourceOptions } from "./IosH264SourceConfig";

/** Helper stderr lines kept for the exit report. */
const HELPER_STDERR_TAIL_LINES = 5;

interface IosCaptureDiagnosticsDependencies {
  isCurrentHelper(): boolean;
  isActive(): boolean;
  confirmIdleSupport(): void;
  nativeIdleCapabilityConfirmed(): boolean;
  setRequiredPermission(permission: CapturePermission): void;
  setRequiredPermissionTarget(target: string): void;
  setLastReadinessPhase(phase: IosScreenCaptureReadinessPhase): void;
  helperStderrTail(): string[];
  failForHelperLine(line: string): void;
  pipeline: Pick<
    IosFramePipeline,
    "helperFrameMetrics" | "nativeFrameMetrics" | "reportFrameMetrics"
  >;
  options: Pick<
    IosH264SourceOptions,
    "onIdleAttestationSupport" | "onSourceIdle" | "onDroppedFrames" | "audioEnabled" | "onAudioData"
  >;
}

/** stderr/readiness/metrics/audio wiring shared by the raw and encoded paths. */
export function wireHelperDiagnostics(
  helper: IosFrameCaptureHelper,
  dependencies: IosCaptureDiagnosticsDependencies,
): void {
  helper.on("capability", (token) => {
    if (dependencies.isCurrentHelper() && token === SIMULATOR_IDLE_EVIDENCE_CAPABILITY) {
      dependencies.confirmIdleSupport();
      dependencies.options.onIdleAttestationSupport?.(true);
    }
  });
  helper.on("idle", () => {
    if (
      dependencies.isCurrentHelper() &&
      dependencies.isActive() &&
      dependencies.nativeIdleCapabilityConfirmed()
    ) {
      dependencies.options.onSourceIdle?.();
    }
  });
  helper.on("frameMetrics", (metrics) => {
    if (dependencies.isCurrentHelper() && dependencies.isActive()) {
      dependencies.pipeline.helperFrameMetrics = metrics;
      dependencies.pipeline.reportFrameMetrics();
    }
  });
  helper.on("captureMetrics", (metrics) => {
    if (dependencies.isCurrentHelper() && dependencies.isActive()) {
      dependencies.pipeline.nativeFrameMetrics = metrics;
      // The native writer's cumulative counter is the only one the encoded Simulator path (the
      // default) advances on VideoToolbox overload — the raw-frame queue's `frameMetrics` counter
      // never fires there because that path bypasses enqueueFrame. Forward the native counter so
      // encoder saturation actually reaches the desktop quality controller.
      dependencies.options.onDroppedFrames?.(metrics.droppedFrames);
      dependencies.pipeline.reportFrameMetrics();
    }
  });
  helper.on("audio", (audio) => {
    if (
      dependencies.isCurrentHelper() &&
      dependencies.isActive() &&
      dependencies.options.audioEnabled
    ) {
      dependencies.options.onAudioData?.(audio.pcm16le);
    }
  });
  helper.on("permission", (permission) => {
    if (dependencies.isCurrentHelper()) {
      dependencies.setRequiredPermission(permission);
    }
  });
  helper.on("permissionTarget", (target) => {
    if (dependencies.isCurrentHelper()) {
      dependencies.setRequiredPermissionTarget(target);
    }
  });
  helper.on("stderr", (line) => {
    if (!dependencies.isCurrentHelper()) {
      return;
    }
    if (line.length > 0) {
      if (line.startsWith(NATIVE_FRAME_METRICS_PREFIX)) {
        logNativeFrameMetricsStderr(line);
      } else {
        // Periodic metrics lines must not displace the crash diagnostics a
        // SIGTRAP/SIGABRT exit report needs (#7604).
        dependencies.helperStderrTail().push(line.slice(-2_048));
        if (dependencies.helperStderrTail().length > HELPER_STDERR_TAIL_LINES) {
          dependencies.helperStderrTail().shift();
        }
        // The helper runs in a separate process. Preserve its diagnostics in the
        // daemon log: a SIGABRT otherwise leaves CI with only an exit signal.
        logger.warn(`[IosH264Source] screen-capture-helper stderr: ${line}`);
      }
    }
    if (isHelperError(line)) {
      dependencies.failForHelperLine(line);
    }
  });
  helper.on("readiness", (status) => {
    if (dependencies.isCurrentHelper() && dependencies.isActive()) {
      // Track the furthest startup stage reached so a first-frame timeout can
      // name exactly where capture stalled (issue #4766).
      dependencies.setLastReadinessPhase(status.phase);
    }
    logger.debug(
      `[IosH264Source] capture readiness phase=${status.phase} atMs=${status.atMs}${status.detail ? ` detail=${status.detail}` : ""}`,
    );
  });
}

function logNativeFrameMetricsStderr(line: string): void {
  try {
    const value: unknown = JSON.parse(line.slice(NATIVE_FRAME_METRICS_PREFIX.length));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      logger.warn(`[IosH264Source] unrecognised frame-metrics line: ${line}`);
      return;
    }
    const metrics = value as Record<string, unknown>;
    if (
      (typeof metrics.droppedFrames === "number" && metrics.droppedFrames > 0) ||
      (typeof metrics.frameQueueDepth === "number" && metrics.frameQueueDepth !== 0)
    ) {
      logger.warn(`[IosH264Source] screen-capture-helper frame metrics: ${line}`);
      return;
    }
    logger.debug(`[IosH264Source] screen-capture-helper frame metrics: ${line}`);
  } catch (error) {
    logger.warn(`[IosH264Source] unrecognised frame-metrics line: ${line}; ${errorMessage(error)}`);
  }
}
