import type { AvdInfo } from "./android-cmdline-tools/avdmanager";
import type { AvdManager } from "./android-cmdline-tools/interfaces/AvdManager";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import type { Timer } from "./SystemTimer";

export const CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS = 2_000;

/**
 * AVD provenance changes only with AVD lifecycle operations, so retain the successful
 * enumeration until that lifecycle path explicitly invalidates it.
 */
export class AndroidAvdProvenanceCache {
  private static instance: AndroidAvdProvenanceCache | undefined;
  private cached: ReadonlyMap<string, AvdInfo> | undefined;
  private inFlight: Promise<ReadonlyMap<string, AvdInfo>> | undefined;
  private inFlightController: AbortController | undefined;
  private generation = 0;

  static getInstance(): AndroidAvdProvenanceCache {
    AndroidAvdProvenanceCache.instance ??= new AndroidAvdProvenanceCache();
    return AndroidAvdProvenanceCache.instance;
  }

  static resetForTests(): void {
    AndroidAvdProvenanceCache.instance?.invalidate();
    AndroidAvdProvenanceCache.instance = undefined;
  }

  getByName(
    avdManager: Pick<AvdManager, "listDeviceImages">,
    timer: Timer,
    timeoutMs: number = CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS,
  ): Promise<ReadonlyMap<string, AvdInfo>> {
    if (this.cached) {
      return Promise.resolve(this.cached);
    }
    if (this.inFlight) {
      return this.inFlight;
    }

    const generation = this.generation;
    const controller = new AbortController();
    this.inFlightController = controller;
    const inFlight = this.fetch(avdManager, timer, timeoutMs, controller, generation);
    this.inFlight = inFlight;
    return inFlight;
  }

  invalidate(): void {
    this.generation++;
    this.cached = undefined;
    this.inFlightController?.abort(new Error("Android AVD provenance cache invalidated"));
    this.inFlightController = undefined;
    this.inFlight = undefined;
  }

  private async fetch(
    avdManager: Pick<AvdManager, "listDeviceImages">,
    timer: Timer,
    timeoutMs: number,
    controller: AbortController,
    generation: number,
  ): Promise<ReadonlyMap<string, AvdInfo>> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = timer.setTimeout(() => {
          const error = new Error(`Android AVD provenance lookup timed out after ${timeoutMs}ms`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      });
      const avds = await Promise.race([avdManager.listDeviceImages(controller.signal), timeout]);
      const result = new Map(avds.map((avd) => [avd.name, avd]));
      if (this.generation === generation) {
        this.cached = result;
      }
      return result;
    } catch (error) {
      logger.warn(`Android AVD provenance lookup failed: ${errorMessage(error)}`, error);
      return new Map();
    } finally {
      if (timeoutHandle) {
        timer.clearTimeout(timeoutHandle);
      }
      if (this.generation === generation && this.inFlightController === controller) {
        this.inFlight = undefined;
        this.inFlightController = undefined;
      }
    }
  }
}
