import { ActionableError } from "../../models/ActionableError";
import type { BootedDevice, ObserveResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { errorMessage as describeError } from "../../utils/describeUnknownError";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { resolveTargetDisplay } from "./DisplaySelection";
import type { ObservedAndroidDisplayCache } from "./ObservationDisplay";
import type { ScreenshotService } from "./interfaces/ScreenshotService";
import type { ScreenshotEncodingOptions } from "./screenshot/screenshotOptions";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import {
  observationScreenshotEvidence,
  type ScreenshotEvidenceFiles,
} from "./screenshot/observationScreenshotEvidence";
import type { ScreenshotPathProtection } from "./ScreenshotPathProtection";
import { TakeScreenshot } from "./TakeScreenshot";
import type { SettledScreenshotCapture } from "./SettledScreenshotCapture";

/** Same panel key and display generation: the only proof a cached capture shows this panel. */
function sameObservedPanel(
  cached: ObserveResult["display"] | undefined,
  observed: ObserveResult["display"],
): boolean {
  return cached?.key === observed.key && cached.generation === observed.generation;
}

/** Lazy getters: ObserveScreen tests may reassign these collaborators after construction. */
export interface DeviceReadScreenshotDeps {
  device: () => BootedDevice;
  adb: () => AdbExecutor;
  timer: () => Timer;
  requestedDisplay: () => string | undefined;
  observedAndroidDisplayCache: () => ObservedAndroidDisplayCache;
  screenshotService: () => ScreenshotService;
  screenshotEvidenceFiles: () => ScreenshotEvidenceFiles | undefined;
  pathProtection: () => ScreenshotPathProtection;
  settledScreenshots: () => SettledScreenshotCapture;
}

/** Screenshot capture for a device read, with the cached-screenshot fallback and display resolution. */
export class DeviceReadScreenshot {
  constructor(private readonly deps: DeviceReadScreenshotDeps) {}

  private get device(): BootedDevice {
    return this.deps.device();
  }
  private get adb(): AdbExecutor {
    return this.deps.adb();
  }
  private get timer(): Timer {
    return this.deps.timer();
  }
  private get requestedDisplay(): string | undefined {
    return this.deps.requestedDisplay();
  }
  private get observedAndroidDisplayCache(): ObservedAndroidDisplayCache {
    return this.deps.observedAndroidDisplayCache();
  }
  private get screenshotService(): ScreenshotService {
    return this.deps.screenshotService();
  }
  private get screenshotEvidenceFiles(): ScreenshotEvidenceFiles | undefined {
    return this.deps.screenshotEvidenceFiles();
  }
  private get pathProtection(): ScreenshotPathProtection {
    return this.deps.pathProtection();
  }
  private settledScreenshots(): SettledScreenshotCapture {
    return this.deps.settledScreenshots();
  }

  async captureDeviceReadScreenshot(
    result: ObserveResult,
    signal?: AbortSignal,
    screenshotOptions?: ScreenshotEncodingOptions,
    options: { requireFreshScreenshot?: boolean; display?: string } = {},
  ): Promise<void> {
    const { requireFreshScreenshot = false, display = this.requestedDisplay } = options;
    result.screenshotCaptureAttempted = true;
    result.screenshotOrientation = this.device.platform === "ios" ? "native" : "display";
    const displayId = await this.resolveReadDisplayId(result, { signal, display });
    const captureOptions = {
      format: screenshotOptions?.format ?? "png",
      ...screenshotOptions,
      displayId,
    };
    const capture =
      this.screenshotService instanceof TakeScreenshot
        ? await this.screenshotService.executeObservationRead(captureOptions, signal)
        : await this.screenshotService.execute(captureOptions, signal);
    signal?.throwIfAborted();
    if (capture.success && capture.path) {
      Object.assign(
        result,
        await observationScreenshotEvidence(capture.path, "fresh", undefined, {
          files: this.screenshotEvidenceFiles,
          timer: this.timer,
          protection: this.pathProtection,
        }),
      );
      await this.settledScreenshots().attachScreenshotRaster(result, capture.screenshotImageSize);
      result.screenshotSettled = true;
      return;
    }
    await this.handleDeviceReadScreenshotFailure(
      result,
      capture.error ?? "Screenshot capture failed",
      displayId,
      requireFreshScreenshot,
    );
  }

  private async handleDeviceReadScreenshotFailure(
    result: ObserveResult,
    failure: string,
    displayId: number | undefined,
    requireFreshScreenshot: boolean,
  ): Promise<void> {
    if (requireFreshScreenshot) {
      throw new ActionableError(
        `observe crop screenshot capture failed for device ${this.device.deviceId}: ${failure}. Retry with a fresh settled capture.`,
      );
    }
    const cachedScreenshot = this.eligibleCachedScreenshot(displayId, result.display);
    if (cachedScreenshot) {
      try {
        Object.assign(
          result,
          await observationScreenshotEvidence(cachedScreenshot.path, "cached", failure, {
            files: this.screenshotEvidenceFiles,
            timer: this.timer,
            protection: this.pathProtection,
          }),
        );
        await this.settledScreenshots().attachScreenshotRaster(result, cachedScreenshot.imageSize);
      } catch (error) {
        logger.warn(`[OBSERVE] Cached screenshot unavailable: ${describeError(error)}`, error);
      }
    }
    result.screenshotSettled = false;
    result.screenshotSettledError = failure;
  }

  async resolveReadDisplayId(
    result: ObserveResult,
    options: { signal?: AbortSignal; display?: string } = {},
  ): Promise<number | undefined> {
    const { signal, display = this.requestedDisplay } = options;
    if (this.device.platform !== "android" || !display || display === "active") {
      return undefined;
    }
    const panel = resolveTargetDisplay(this.device.displays, display, {});
    const displayId = await this.observedAndroidDisplayCache.logicalIdForPanel(
      this.device,
      this.adb,
      panel.key,
      signal,
    );
    result.display = { ...result.display, key: panel.key, role: panel.role };
    return displayId;
  }

  private eligibleCachedScreenshot(
    displayId: number | undefined,
    observed: ObserveResult["display"],
  ): { path: string; imageSize?: { width: number; height: number } } | undefined {
    const cached = getObserveCacheStore().getRecentInMemoryForDevice(this.device.deviceId);
    if (!this.cachedScreenshotDisplayMatches(cached, displayId, observed)) {
      return undefined;
    }
    if (cached?.screenshotPath) {
      return { path: cached.screenshotPath, imageSize: cached.screenshotImageSize };
    }
    const path = this.deviceWideScreenshotPath(displayId);
    return path ? { path } : undefined;
  }

  /** The device-wide screenshot state has no panel provenance, so it never serves a multi-panel device. */
  private deviceWideScreenshotPath(displayId: number | undefined): string | undefined {
    const explicitDisplay = Boolean(this.requestedDisplay && this.requestedDisplay !== "active");
    return !explicitDisplay && displayId === undefined && !this.hasMultiplePanels()
      ? getScreenshotStateStore().getPath(this.device.deviceId)
      : undefined;
  }

  private hasMultiplePanels(): boolean {
    return (this.device.displays?.panels.length ?? 0) > 1;
  }

  private cachedScreenshotDisplayMatches(
    cached: ObserveResult | undefined,
    displayId: number | undefined,
    observed: ObserveResult["display"],
  ): boolean {
    const displayMatches = [
      undefined,
      "active",
      cached?.display.key,
      cached?.display.role,
    ].includes(this.requestedDisplay);
    const displayIdMatches = [undefined, cached?.viewHierarchy?.displayId].includes(displayId);
    // A default or "active" read resolves its panel from live state, so the request alone cannot
    // prove which panel a cached screenshot came from. On multi-panel devices the cached entry
    // must carry this observation's panel key and display generation.
    const panelMatches = !this.hasMultiplePanels() || sameObservedPanel(cached?.display, observed);
    return displayMatches && displayIdMatches && panelMatches;
  }
}
