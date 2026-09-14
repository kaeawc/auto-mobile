import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { BootedDevice } from "../../../models";
import { ScreenshotResult } from "../../../models/ScreenshotResult";
import { OPERATION_CANCELLED_MESSAGE } from "../../../utils/constants";
import { pathExists } from "../../../utils/filesystem/DefaultFileSystem";
import { NoOpPerformanceTracker, PerformanceTracker } from "../../../utils/PerformanceTracker";
import type {
  ScreenshotJobHandle,
  ScreenshotJobOptions,
} from "../../../utils/ScreenshotJobTracker";
import { ScreenshotJobTracker } from "../../../utils/ScreenshotJobTracker";
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
    trackerOptions?: ScreenshotJobOptions,
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
  start(observationId: string, perf?: PerformanceTracker, signal?: AbortSignal): void;

  /**
   * Awaitable capture. The promise resolves once the capture has completed
   * (successfully or not) and state has been updated.
   */
  capture(observationId: string, perf?: PerformanceTracker, signal?: AbortSignal): Promise<void>;

  /**
   * Await a fresh capture after any already-pending capture. Terminal evidence
   * must reflect the completed action or wait condition rather than an earlier
   * in-flight observation.
   */
  captureFresh(
    observationId: string,
    perf?: PerformanceTracker,
    signal?: AbortSignal,
  ): Promise<void>;
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
  private readonly completionByJob = new Map<string, { aborted: boolean; isLatest: boolean }>();
  private readonly observationResultCountByJob = new Map<string, number>();

  constructor(
    device: BootedDevice,
    screenshotUtil: TrackedScreenshotService,
    store: ScreenshotStateStore = getScreenshotStateStore(),
  ) {
    this.device = device;
    this.screenshotUtil = screenshotUtil;
    this.store = store;
  }

  start(
    observationId: string,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): void {
    this.store.beginObservation(this.device.deviceId, observationId);
    perf.startOperation("screenshot");
    const handle = this.screenshotUtil.startTrackedCapture(
      {},
      {
        parentSignal: signal,
        // Fire-and-forget: coalesce work that has not started yet, but queue
        // once a screencap runner is executing so its pixels cannot be paired
        // with a later observation. Cancelling and restarting every ~100ms
        // causes a self-inflicted cancel loop because screencap takes
        // ~200-300ms — no screenshot ever completes.
        coalesceWithPending: true,
        queueAfterPendingIfRunning: true,
        onComplete: async (completion) => {
          this.completionByJob.set(completion.jobId, {
            aborted: completion.aborted,
            isLatest: completion.isLatest,
          });
          if (!completion.isLatest) {
            this.store.endObservation(this.device.deviceId, observationId, "capture superseded");
            return;
          }
          if (completion.aborted) {
            logger.debug("[OBSERVE] Screenshot capture cancelled");
            this.store.endObservation(this.device.deviceId, observationId, "capture cancelled");
            return;
          }
          try {
            await this.handleScreenshotResult(completion.result, { ignoreCancel: true });
          } catch (err) {
            logger.warn(`[OBSERVE] Failed to finalize screenshot capture: ${err}`);
          }
        },
      },
    );

    void this.recordObservationResult(handle, observationId);

    // Swallow rejections from the chained finally so an unexpected throw inside
    // the tracked capture doesn't surface as an unhandled rejection. The
    // `onComplete` handler already records failures via the state store.
    handle.promise
      .finally(() => {
        perf.endOperation("screenshot");
      })
      .catch(() => {
        /* error already recorded in onComplete */
      });
  }

  async capture(
    observationId: string,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    this.store.beginObservation(this.device.deviceId, observationId);
    await this.captureWithOptions(observationId, perf, signal, {
      coalesceWithPending: true,
      queueAfterPendingIfRunning: true,
    });
  }

  async captureFresh(
    observationId: string,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    this.store.beginObservation(this.device.deviceId, observationId);
    await this.captureWithOptions(observationId, perf, signal, { queueAfterPending: true });
  }

  private async captureWithOptions(
    observationId: string,
    perf: PerformanceTracker,
    signal: AbortSignal | undefined,
    trackerOptions: Pick<
      ScreenshotJobOptions,
      "coalesceWithPending" | "queueAfterPending" | "queueAfterPendingIfRunning"
    >,
  ): Promise<void> {
    try {
      await perf.track("screenshot", async () => {
        const handle = this.screenshotUtil.startTrackedCapture(
          {},
          {
            parentSignal: signal,
            ...trackerOptions,
            onComplete: async (completion) => {
              this.completionByJob.set(completion.jobId, {
                aborted: completion.aborted,
                isLatest: completion.isLatest,
              });
              if (!completion.isLatest) {
                this.store.endObservation(
                  this.device.deviceId,
                  observationId,
                  "capture superseded",
                );
                return;
              }
              if (completion.aborted) {
                logger.debug("[OBSERVE] Screenshot capture cancelled");
                this.store.endObservation(this.device.deviceId, observationId, "capture cancelled");
                return;
              }
              try {
                await this.handleScreenshotResult(completion.result, { ignoreCancel: true });
              } catch (err) {
                logger.warn(`[OBSERVE] Failed to finalize screenshot capture: ${err}`);
              }
            },
          },
        );
        const observationResult = this.recordObservationResult(handle, observationId);
        await handle.promise;
        await observationResult;
      });
    } catch (error) {
      const errorMsg = errorMessage(error);
      if (errorMsg.includes(OPERATION_CANCELLED_MESSAGE)) {
        logger.debug("[OBSERVE] Screenshot capture cancelled");
        return;
      }
      this.store.update(this.device.deviceId, undefined, errorMsg);
      this.store.updateForObservation(this.device.deviceId, observationId, undefined, errorMsg);
      logger.warn(`[OBSERVE] Screenshot capture failed: ${errorMsg}`);
    }
  }

  private async handleScreenshotResult(
    screenshotResult: ScreenshotResult,
    options: { ignoreCancel?: boolean; observationId?: string; updateDeviceWide?: boolean } = {},
  ): Promise<void> {
    const update = (path?: string, error?: string) => {
      if (options.updateDeviceWide !== false) {
        this.store.update(this.device.deviceId, path, error);
      }
      if (options.observationId) {
        this.store.updateForObservation(this.device.deviceId, options.observationId, path, error);
      }
    };
    if (!screenshotResult.success) {
      const errorMsg = screenshotResult.error || "Failed to capture screenshot";
      if (options.ignoreCancel && errorMsg.includes(OPERATION_CANCELLED_MESSAGE)) {
        logger.debug("[OBSERVE] Screenshot capture cancelled");
        return;
      }
      update(undefined, errorMsg);
      logger.warn(`[OBSERVE] Screenshot capture failed: ${errorMsg}`);
      return;
    }

    if (!screenshotResult.path) {
      update(undefined, "Screenshot capture returned no file path");
      logger.warn("[OBSERVE] Screenshot capture succeeded but no file path was returned");
      return;
    }

    const exists = await pathExists(screenshotResult.path);
    if (!exists) {
      update(undefined, "Screenshot file missing after capture");
      logger.warn(
        `[OBSERVE] Screenshot capture reported success but file missing: ${screenshotResult.path}`,
      );
      return;
    }

    update(screenshotResult.path);
  }

  private recordObservationResult(
    handle: ScreenshotJobHandle,
    observationId: string,
  ): Promise<void> {
    ScreenshotJobTracker.registerCompletionReader(handle.jobId);
    this.observationResultCountByJob.set(
      handle.jobId,
      (this.observationResultCountByJob.get(handle.jobId) ?? 0) + 1,
    );
    let released = false;
    const releaseCompletion = () => {
      if (released) {
        return;
      }
      released = true;
      ScreenshotJobTracker.releaseCompletionReader(handle.jobId);
      const remaining = (this.observationResultCountByJob.get(handle.jobId) ?? 1) - 1;
      if (remaining <= 0) {
        this.observationResultCountByJob.delete(handle.jobId);
        this.completionByJob.delete(handle.jobId);
        return;
      }
      this.observationResultCountByJob.set(handle.jobId, remaining);
    };

    return handle.promise
      .then(async (result) => {
        const snapshot =
          ScreenshotJobTracker.getCompletion(handle.jobId) ??
          this.completionByJob.get(handle.jobId);
        releaseCompletion();
        if (!snapshot || snapshot.aborted || !snapshot.isLatest) {
          logger.debug("[OBSERVE] Screenshot capture cancelled");
          this.store.endObservation(
            this.device.deviceId,
            observationId,
            snapshot?.isLatest === false ? "capture superseded" : "capture cancelled",
          );
          return;
        }
        await this.handleScreenshotResult(result, {
          ignoreCancel: true,
          observationId,
          updateDeviceWide: false,
        });
      })
      .catch((error) => {
        releaseCompletion();
        const errorMsg = errorMessage(error);
        this.store.updateForObservation(this.device.deviceId, observationId, undefined, errorMsg);
        logger.warn(
          `[OBSERVE] Failed to record screenshot for observation ${observationId}: ${errorMsg}`,
        );
      });
  }
}
