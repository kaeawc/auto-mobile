import { ActionableError } from "../../models/ActionableError";
import { StrictSettledScreenshotCaptureError } from "./StrictSettledScreenshotCaptureError";
import type { BootedDevice, ObserveResult, ViewHierarchyResult } from "../../models";
import { requireAndroidOrIosPlatform } from "../../models";
import type { PerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage as describeError } from "../../utils/describeUnknownError";
import type { ObserveScreenshotOptions } from "./screenshot/screenshotOptions";
import type { ObserveScreenshotRecorder } from "./screenshot/ObserveScreenshotRecorder";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import { snapshotRasterGeometry } from "./screenshot/snapshotRasterGeometry";
import { RASTER_SCALE_TOLERANCE } from "./screenshot/rasterGeometry";
import { resolveIosObserveRotation } from "./iosObserveRotation";
import { appendObserveError } from "./ObserveError";
import { hasUsableHierarchy } from "./ActiveWindowAttribution";
import {
  observationScreenshotEvidence,
  type ScreenshotEvidenceFiles,
} from "./screenshot/observationScreenshotEvidence";
import type { ScreenshotPathProtection } from "./ScreenshotPathProtection";

/** Lazy getters: ObserveScreen tests may reassign these collaborators after construction. */
export interface SettledScreenshotCaptureDeps {
  device: () => BootedDevice;
  timer: () => Timer;
  screenshotRecorder: () => ObserveScreenshotRecorder;
  screenshotEvidenceFiles: () => ScreenshotEvidenceFiles | undefined;
  pathProtection: () => ScreenshotPathProtection;
}

/** Which display a settled screenshot captures, and how it is encoded. */
export interface SettledScreenshotTarget {
  displayId?: number;
  screenshotOptions?: ObserveScreenshotOptions;
}

/** Settled screenshot capture and the raster evidence attached to its observation. */
export class SettledScreenshotCapture {
  constructor(private readonly deps: SettledScreenshotCaptureDeps) {}

  private get device(): BootedDevice {
    return this.deps.device();
  }
  private get timer(): Timer {
    return this.deps.timer();
  }
  private get screenshotRecorder(): ObserveScreenshotRecorder {
    return this.deps.screenshotRecorder();
  }
  private get screenshotEvidenceFiles(): ScreenshotEvidenceFiles | undefined {
    return this.deps.screenshotEvidenceFiles();
  }
  private get pathProtection(): ScreenshotPathProtection {
    return this.deps.pathProtection();
  }

  async captureSettledScreenshot(
    observation: ObserveResult,
    perf: PerformanceTracker,
    signal: AbortSignal | undefined,
    { strict, displayId, screenshotOptions }: SettledScreenshotTarget & { strict: boolean },
  ): Promise<void> {
    try {
      if (!this.screenshotRecorder.captureSettled) {
        throw new ActionableError("Settled screenshot capture is unavailable");
      }
      const path = await this.screenshotRecorder.captureSettled(observation.observationId, {
        perf,
        signal,
        displayId,
        options: screenshotOptions,
      });
      const screenshotEvidence = await observationScreenshotEvidence(path, "fresh", undefined, {
        files: this.screenshotEvidenceFiles,
        timer: this.timer,
        protection: this.pathProtection,
      });
      Object.assign(observation, screenshotEvidence);
      const imageSize = getScreenshotStateStore().getImageSizeForObservation(
        this.device.deviceId,
        observation.observationId,
        path,
      );
      await this.attachScreenshotRaster(observation, imageSize);
      this.refineIosPanelOrientation(observation);
      observation.screenshotSettled = true;
    } catch (error) {
      signal?.throwIfAborted();
      if (strict) {
        throw new StrictSettledScreenshotCaptureError(error, this.device.deviceId);
      }
      observation.screenshotSettled = false;
      observation.screenshotSettledError = describeError(error);
      logger.warn(
        `[OBSERVE] Settled screenshot unavailable: ${observation.screenshotSettledError}`,
        error,
      );
    }
  }

  private refineIosPanelOrientation(observation: ObserveResult): void {
    // Only settled multi-panel iOS captures refine the platform orientation preset.
    if (this.device.platform === "ios" && (this.device.displays?.panels.length ?? 0) > 1) {
      const rasterSize = observation.screenshotImageSize;
      observation.screenshotOrientation =
        rasterSize &&
        rasterSize.width > rasterSize.height ===
          observation.screenSize.width > observation.screenSize.height
          ? "display"
          : "native";
    }
  }

  /**
   * Without a hierarchy (e.g. the owning session's hierarchy client is disconnected) an iOS
   * multi-panel observation takes its size from the panel inventory, which stores panels
   * portrait, so it has no rotation evidence. A multi-panel capture is display-oriented, so the
   * screenshot aspect orients the panel geometry and rotation (#17846). Returns false, with an
   * actionable observe error, when neither orientation of the geometry fits the screenshot.
   * An unavailable read (e.g. `runner_launch_queued`) still carries an error-shaped hierarchy,
   * which has no rotation authority either, so only a usable hierarchy skips this (#17880).
   */
  private orientHierarchylessPanelToRaster(
    observation: ObserveResult,
    raster: { width: number; height: number },
  ): boolean {
    const { width, height } = observation.screenSize;
    if (
      this.device.platform !== "ios" ||
      hasUsableHierarchy(observation.viewHierarchy) ||
      (this.device.displays?.panels.length ?? 0) < 2 ||
      ![width, height].every((value) => Number.isFinite(value) && value > 0)
    ) {
      return true;
    }
    const fits = (nativeWidth: number, nativeHeight: number): boolean =>
      Math.abs(raster.width / nativeWidth - raster.height / nativeHeight) <= RASTER_SCALE_TOLERANCE;
    if (fits(width, height)) {
      return true;
    }
    if (fits(height, width)) {
      observation.screenSize = { ...observation.screenSize, width: height, height: width };
      observation.rotation = resolveIosObserveRotation(undefined, observation.screenSize);
      return true;
    }
    const message =
      `The ${observation.display.role} panel screenshot (${raster.width}x${raster.height} px) fits neither orientation ` +
      `of its ${width}x${height} geometry, and no view hierarchy was available to confirm the rotation, ` +
      "so the screenshot raster scale is omitted. Observe from the session that owns the device to reconnect its hierarchy client, then retry.";
    logger.warn(`[OBSERVE] ${message}`);
    appendObserveError(observation, { phase: "screenshot", message });
    return false;
  }

  /** Best-effort raster evidence belongs to the returned path, never the screen-size guess. */
  async attachScreenshotRaster(
    observation: ObserveResult,
    imageSize: { width: number; height: number } | undefined,
  ): Promise<void> {
    delete observation.screenshotImageSize;
    delete observation.screenshotPixelsPerNativeUnit;
    delete observation.screenshotScaleProvenance;
    try {
      if (
        !imageSize ||
        ![imageSize.width, imageSize.height].every((value) => Number.isInteger(value) && value > 0)
      ) {
        logger.warn("[OBSERVE] Could not read screenshot raster dimensions");
        return;
      }
      observation.screenshotImageSize = { width: imageSize.width, height: imageSize.height };
      const hierarchy: Partial<ViewHierarchyResult> = observation.viewHierarchy ?? {};
      const platform = requireAndroidOrIosPlatform(
        this.device.platform,
        "Deriving the screenshot raster scale",
      );
      if (!this.orientHierarchylessPanelToRaster(observation, imageSize)) {
        return;
      }
      const scale = snapshotRasterGeometry(
        imageSize,
        {
          platform,
          screenSize: observation.screenSize,
          rotation: hierarchy.rotation ?? observation.rotation,
          nativeScale: hierarchy.nativeScale,
          rasterOrientation:
            platform === "ios" &&
            !(
              (this.device.displays?.panels.length ?? 0) > 1 &&
              imageSize.width > imageSize.height ===
                observation.screenSize.width > observation.screenSize.height
            )
              ? "native"
              : "display",
        },
        "observe",
      );
      observation.screenshotPixelsPerNativeUnit = scale.pixelsPerNativeUnit;
      observation.screenshotScaleProvenance = scale.scaleProvenance;
    } catch (error) {
      logger.warn(
        `[OBSERVE] Could not derive screenshot raster scale: ${describeError(error)}`,
        error,
      );
      return;
    }
  }
}
