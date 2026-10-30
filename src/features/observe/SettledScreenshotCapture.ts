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
    strict: boolean,
    { displayId, screenshotOptions }: SettledScreenshotTarget = {},
  ): Promise<void> {
    try {
      if (!this.screenshotRecorder.captureSettled) {
        throw new ActionableError("Settled screenshot capture is unavailable");
      }
      const path = await this.screenshotRecorder.captureSettled(
        observation.observationId,
        perf,
        signal,
        displayId,
        screenshotOptions,
      );
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
