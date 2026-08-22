import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { BootedDevice } from "../../../models";
import { ScreenshotResult } from "../../../models/ScreenshotResult";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";
import { pathExists } from "../../../utils/filesystem/DefaultFileSystem";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../../utils/PerformanceTracker";
import type { ScreenshotJobHandle, ScreenshotJobOptions } from "../../../utils/ScreenshotJobTracker";
import type { ScreenshotService } from "../interfaces/ScreenshotService";
import type { ScreenshotOptions } from "../TakeScreenshot";
import { getScreenshotStateStore, ScreenshotStateStore } from "./ScreenshotStateRegistry";

/**
 * Minimal capability surface needed by the recorder: the standard
 * `ScreenshotService` plus the `startTrackedCapture` helper that
 * `TakeScreenshot` exposes for fire-and-forget capture. Declared inline so the
 * recorder compiles under strict TS without requiring changes to existing
 * call sites in `ObserveScreen.ts`.
 */
export interface TrackedScreenshotService extends ScreenshotService {
  startTrackedCapture(
    options?: ScreenshotOptions,
    trackerOptions?: ScreenshotJobOptions
  ): ScreenshotJobHandle;
}

/**
 * Orchestrates screenshot capture during observe operations.
 *
 * State writes (success/error/path) go through the injected
 * `ScreenshotStateStore` so server resource handlers can read the latest
 * cached screenshot without instantiating a recorder.
 */
export interface ObserveScreenshotRecorder {
  /**
   * Fire-and-forget capture. Returns immediately while the capture continues
   * in the background. State is updated when the capture completes.
   */
  start(perf?: PerformanceTracker, signal?: AbortSignal): void;

  /**
   * Awaitable capture. The promise resolves once the capture has completed
   * (successfully or not) and state has been updated.
   */
  capture(perf?: PerformanceTracker, signal?: AbortSignal): Promise<void>;
}

/**
 * Default recorder implementation. Behaviour matches the previous in-class
 * methods on `RealObserveScreen` (`handleScreenshotResult`,
 * `captureObservationScreenshot`, `startObservationScreenshot`).
 */
export class DefaultObserveScreenshotRecorder implements ObserveScreenshotRecorder {
  private readonly device: BootedDevice;
  private readonly screenshotUtil: TrackedScreenshotService;
  private readonly store: ScreenshotStateStore;

  constructor(
    device: BootedDevice,
    screenshotUtil: TrackedScreenshotService,
    store: ScreenshotStateStore = getScreenshotStateStore()
  ) {
    this.device = device;
    this.screenshotUtil = screenshotUtil;
    this.store = store;
  }

  start(perf: PerformanceTracker = new NoOpPerformanceTracker(), signal?: AbortSignal): void {
    perf.startOperation("screenshot");
    const { promise } = this.screenshotUtil.startTrackedCapture(
      { format: "png" },
      {
        parentSignal: signal,
        // Fire-and-forget: if a screencap is already in flight (e.g. mid-poll
        // during observe waitFor), reuse it. Cancelling and restarting every
        // ~100ms causes a self-inflicted cancel loop because screencap takes
        // ~200-300ms — no screenshot ever completes.
        coalesceWithPending: true,
        onComplete: async completion => {
          if (!completion.isLatest) {
            return;
          }
          if (completion.aborted) {
            logger.debug("[OBSERVE] Screenshot capture cancelled");
            return;
          }
          try {
            await this.handleScreenshotResult(completion.result, { ignoreCancel: true });
          } catch (err) {
            logger.warn(`[OBSERVE] Failed to finalize screenshot capture: ${err}`);
          }
        }
      }
    );

    // Swallow rejections from the chained finally so an unexpected throw inside
    // the tracked capture doesn't surface as an unhandled rejection. The
    // `onComplete` handler already records failures via the state store.
    promise.finally(() => {
      perf.endOperation("screenshot");
    }).catch(() => { /* error already recorded in onComplete */ });
  }

  async capture(perf: PerformanceTracker = new NoOpPerformanceTracker(), signal?: AbortSignal): Promise<void> {
    try {
      await perf.track("screenshot", async () => {
        const { promise } = this.screenshotUtil.startTrackedCapture(
          { format: "png" },
          {
            parentSignal: signal,
            // Awaitable observe captures share an ordinary in-flight capture,
            // but queue behind a non-coalescible fresh resource capture.
            coalesceWithPending: true,
            onComplete: async completion => {
              if (!completion.isLatest) {
                return;
              }
              if (completion.aborted) {
                logger.debug("[OBSERVE] Screenshot capture cancelled");
                return;
              }
              try {
                await this.handleScreenshotResult(completion.result, { ignoreCancel: true });
              } catch (err) {
                logger.warn(`[OBSERVE] Failed to finalize screenshot capture: ${err}`);
              }
            }
          }
        );
        await promise;
      });
    } catch (error) {
      const errorMsg = errorMessage(error);
      if (errorMsg.includes(OPERATION_CANCELLED_MESSAGE)) {
        logger.debug("[OBSERVE] Screenshot capture cancelled");
        return;
      }
      this.store.update(this.device.deviceId, undefined, errorMsg);
      logger.warn(`[OBSERVE] Screenshot capture failed: ${errorMsg}`);
    }
  }

  private async handleScreenshotResult(
    screenshotResult: ScreenshotResult,
    options: { ignoreCancel?: boolean } = {}
  ): Promise<void> {
    if (!screenshotResult.success) {
      const errorMsg = screenshotResult.error || "Failed to capture screenshot";
      if (options.ignoreCancel && errorMsg.includes(OPERATION_CANCELLED_MESSAGE)) {
        logger.debug("[OBSERVE] Screenshot capture cancelled");
        return;
      }
      this.store.update(this.device.deviceId, undefined, errorMsg);
      logger.warn(`[OBSERVE] Screenshot capture failed: ${errorMsg}`);
      return;
    }

    if (!screenshotResult.path) {
      this.store.update(this.device.deviceId, undefined, "Screenshot capture returned no file path");
      logger.warn("[OBSERVE] Screenshot capture succeeded but no file path was returned");
      return;
    }

    const exists = await pathExists(screenshotResult.path);
    if (!exists) {
      this.store.update(this.device.deviceId, undefined, "Screenshot file missing after capture");
      logger.warn(`[OBSERVE] Screenshot capture reported success but file missing: ${screenshotResult.path}`);
      return;
    }

    this.store.update(this.device.deviceId, screenshotResult.path);
  }
}
