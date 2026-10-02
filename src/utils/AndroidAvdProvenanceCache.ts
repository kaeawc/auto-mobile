import type { AvdInfo } from "./android-cmdline-tools/avdmanager";
import type { AvdManager } from "./android-cmdline-tools/interfaces/AvdManager";
import { errorMessage } from "./describeUnknownError";
import { logger } from "./logger";
import type { Timer } from "./SystemTimer";
import { runWithAbortSignal } from "./AbortContext";
import { raceWithDeadline } from "./raceWithDeadline";

export const CONFIGURED_IMAGE_FALLBACK_TIMEOUT_MS = 2_000;
export const ANDROID_AVD_PROVENANCE_FETCH_CAP_MS = 30_000;
export const ANDROID_AVD_PROVENANCE_FAILURE_COOLDOWN_MS = 5_000;

export type AndroidAvdProvenanceStatus =
  | { state: "cached" }
  | { state: "in-flight" }
  | { state: "not-attempted" }
  | { state: "failed"; cause: string; at: number };

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
  private failedUntil = 0;
  private failure: Extract<AndroidAvdProvenanceStatus, { state: "failed" }> | undefined;

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
    if (timer.now() < this.failedUntil) {
      return Promise.resolve(new Map());
    }
    if (this.inFlight && this.inFlightController?.signal.aborted) {
      return this.inFlight.then(() => this.getByName(avdManager, timer, timeoutMs));
    }
    if (!this.inFlight) {
      const controller = new AbortController();
      this.inFlightController = controller;
      this.inFlight = runWithAbortSignal(undefined, () =>
        this.fetch(avdManager, { timer, controller, generation: this.generation }),
      );
    }
    return this.waitForCaller(this.inFlight, timer, timeoutMs);
  }

  private async waitForCaller(
    shared: Promise<ReadonlyMap<string, AvdInfo>>,
    timer: Timer,
    timeoutMs: number,
  ): Promise<ReadonlyMap<string, AvdInfo>> {
    try {
      return await raceWithDeadline(shared, {
        timer,
        timeoutMs,
        label: "Android AVD provenance wait",
      });
    } catch (error) {
      // Only this caller stops waiting; the shared fetch keeps running for other readers.
      logger.debug(`Android AVD provenance caller wait elapsed: ${errorMessage(error)}`);
      return new Map();
    }
  }

  /**
   * Returns the last complete provenance observation without starting discovery.
   * Hot device-acquisition responses may use this optional enrichment, but must
   * never make an AVD inventory scan part of their completion path.
   */
  getCachedByName(): ReadonlyMap<string, AvdInfo> | undefined {
    return this.cached;
  }

  getStatus(): AndroidAvdProvenanceStatus {
    if (this.cached) {
      return { state: "cached" };
    }
    if (this.inFlight) {
      return { state: "in-flight" };
    }
    return this.failure ?? { state: "not-attempted" };
  }

  invalidate(): void {
    this.generation++;
    this.cached = undefined;
    this.failedUntil = 0;
    this.failure = undefined;
    this.inFlightController?.abort(new Error("Android AVD provenance cache invalidated"));
    // Retain the flight until its abort settles; a new reader must not launch a second child.
  }

  private async fetch(
    avdManager: Pick<AvdManager, "listDeviceImages">,
    {
      timer,
      controller,
      generation,
    }: { timer: Timer; controller: AbortController; generation: number },
  ): Promise<ReadonlyMap<string, AvdInfo>> {
    const timeoutMs = ANDROID_AVD_PROVENANCE_FETCH_CAP_MS;
    const timeoutFailure = new Error(
      `Android AVD provenance lookup timed out after ${timeoutMs}ms`,
    );
    try {
      const avds = await raceWithDeadline(avdManager.listDeviceImages(controller.signal), {
        timer,
        timeoutMs,
        signal: controller.signal,
        label: "Android AVD provenance lookup",
        timeoutError: () => timeoutFailure,
        onTimeout: () => controller.abort(timeoutFailure),
      });
      const result = new Map(avds.map((avd) => [avd.name, avd]));
      if (this.generation === generation) {
        this.cached = result;
      }
      return result;
    } catch (error) {
      if (this.generation !== generation) {
        // Lifecycle invalidation intentionally cancels this obsolete fetch.
        logger.debug(`Android AVD provenance fetch superseded: ${errorMessage(error)}`);
        return new Map();
      }
      logger.warn(`Android AVD provenance lookup failed: ${errorMessage(error)}`, error);
      if (this.generation === generation) {
        this.failure = { state: "failed", cause: errorMessage(error), at: timer.now() };
        this.failedUntil = timer.now() + ANDROID_AVD_PROVENANCE_FAILURE_COOLDOWN_MS;
      }
      return new Map();
    } finally {
      if (this.inFlightController === controller) {
        this.inFlight = undefined;
        this.inFlightController = undefined;
      }
    }
  }
}
