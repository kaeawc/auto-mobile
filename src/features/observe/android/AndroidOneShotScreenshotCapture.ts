import type { ScreenshotOptions } from "../TakeScreenshot";
import type { ScreenshotResult } from "../../../models/ScreenshotResult";
import type { Timer } from "../../../utils/SystemTimer";
import { toActionableError } from "../../../models/ActionableError";
import { errorMessage } from "../../../utils/describeUnknownError";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";
import { logger } from "../../../utils/logger";
import { replaceScreenshotExtension } from "../../../utils/screenshot/screenshotFormats";
import type { ScreenshotFallbackReason, ScreenshotStageDurationsMs } from "../ScreenshotMetadata";
import type { CtrlProxyCaptureCooldown } from "./CtrlProxyCaptureCooldown";
import { fallbackReasonForCtrlProxyFailure } from "./screenshotFallbackReason";

export interface AndroidOneShotScreenshotContext {
  deviceId: string;
  timer: Pick<Timer, "now">;
  cooldown: CtrlProxyCaptureCooldown;
  captureCtrlProxy(
    path: string,
    signal: AbortSignal | undefined,
    displayId: number | undefined,
    legacyFormat: boolean,
  ): Promise<ScreenshotResult>;
  captureAdb(
    path: string,
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult>;
  captureHidden(
    path: string,
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult>;
}

/** One-shot backend selection and timing; transport and persistence stay with the caller. */
export class AndroidOneShotScreenshotCapture {
  constructor(private readonly context: AndroidOneShotScreenshotContext) {}

  async capture(
    finalPath: string,
    options: ScreenshotOptions = { format: "png" },
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    const startedAt = this.context.timer.now();
    const stages: ScreenshotStageDurationsMs = { totalMs: 0 };
    let result: ScreenshotResult | undefined;
    try {
      result = await this.captureAndroidWithFallback(finalPath, options, stages, signal);
      return result.success ? { ...result, screenshotStageDurationsMs: stages } : result;
    } finally {
      stages.totalMs = this.context.timer.now() - startedAt;
      logger.info(
        `[SCREENSHOT] Capture source=${result?.screenshotCaptureSource ?? "none"} ` +
          `fallbackReason=${result?.screenshotFallbackReason ?? "none"} ` +
          `stageDurationsMs=${JSON.stringify(stages)}`,
      );
    }
  }

  private async captureAndroidWithFallback(
    finalPath: string,
    options: ScreenshotOptions,
    stages: ScreenshotStageDurationsMs,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    if (options.hidePrototypes === true) {
      const startedAt = this.context.timer.now();
      try {
        return await this.context.captureHidden(finalPath, options, signal);
      } finally {
        stages.ctrlProxyMs = this.context.timer.now() - startedAt;
      }
    }

    let fallbackReason: ScreenshotFallbackReason | undefined;
    if (
      options.format === undefined ||
      (options.format === "jpeg" && options.quality === undefined)
    ) {
      const attempt = await this.attemptAndroidCtrlProxy(finalPath, options, stages, signal);
      if (attempt.capture) {
        return attempt.capture;
      }
      fallbackReason = attempt.fallbackReason;
      if (options.format === undefined) {
        finalPath = replaceScreenshotExtension(finalPath, "png");
        options = { ...options, format: "png" };
      }
    }

    const startedAt = this.context.timer.now();
    try {
      const result = await this.context.captureAdb(finalPath, options, signal);
      return { ...result, ...(fallbackReason ? { screenshotFallbackReason: fallbackReason } : {}) };
    } finally {
      stages.adbMs = this.context.timer.now() - startedAt;
    }
  }

  private async attemptAndroidCtrlProxy(
    finalPath: string,
    options: ScreenshotOptions,
    stages: ScreenshotStageDurationsMs,
    signal?: AbortSignal,
  ): Promise<{ capture?: ScreenshotResult; fallbackReason?: ScreenshotFallbackReason }> {
    // Explicit displays must retain the CtrlProxy error instead of falling back to ADB.
    if (
      options.displayId === undefined &&
      this.context.cooldown.hasRecentFailure(this.context.deviceId)
    ) {
      return { fallbackReason: "ctrlproxy_recent_failure" };
    }
    const startedAt = this.context.timer.now();
    try {
      const capture = await this.context.captureCtrlProxy(
        finalPath,
        signal,
        options.displayId,
        options.format === undefined,
      );
      if (capture.success) {
        this.context.cooldown.clear(this.context.deviceId);
      }
      return { capture };
    } catch (error) {
      if (signal?.aborted) {
        logger.warn(`[SCREENSHOT] Android capture cancelled: ${errorMessage(error)}`, error);
        return { capture: { success: false, error: OPERATION_CANCELLED_MESSAGE } };
      }
      const fallbackReason = fallbackReasonForCtrlProxyFailure(errorMessage(error));
      if (fallbackReason !== "ctrlproxy_rate_limited") {
        this.context.cooldown.recordFailure(this.context.deviceId);
      }
      if (options.displayId !== undefined) {
        throw toActionableError(error, "Android display screenshot capture failed");
      }
      logger.warn(
        `[SCREENSHOT] CtrlProxy capture failed, falling back to ADB: ${errorMessage(error)}`,
        error,
      );
      return { fallbackReason };
    } finally {
      stages.ctrlProxyMs = this.context.timer.now() - startedAt;
    }
  }
}
