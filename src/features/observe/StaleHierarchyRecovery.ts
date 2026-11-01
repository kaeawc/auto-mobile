import type { AndroidOrIosPlatform, BootedDevice, ObserveResult } from "../../models";
import { requireAndroidOrIosPlatform } from "../../models";
import type { ViewHierarchyResult } from "../../models";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { NoOpPerformanceTracker } from "../../utils/PerformanceTracker";
import type { Timer } from "../../utils/SystemTimer";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import { errorMessage as describeError } from "../../utils/describeUnknownError";
import { appendObserveError } from "./ObserveError";
import {
  hasUsableHierarchy,
  treeNamesWindow,
  type ActiveWindowAttributionReconciler,
} from "./ActiveWindowAttribution";
import type { DeviceStateCollectorPort } from "./collectors/collectorPorts";
import type { HierarchyPlatformValidator } from "./HierarchyPlatformValidator";
import type { ViewHierarchy as ViewHierarchyInterface } from "./interfaces/ViewHierarchy";
import type { ObserveScreenExecuteOptions } from "./interfaces/ObserveScreen";

/** Lazy getters: ObserveScreen tests may reassign these collaborators after construction. */
export interface StaleHierarchyRecoveryDeps {
  timer: () => Timer;
  device: () => BootedDevice;
  viewHierarchy: () => ViewHierarchyInterface;
  deviceStateCollector: () => DeviceStateCollectorPort;
  platformValidator: () => HierarchyPlatformValidator;
  reconciler: () => ActiveWindowAttributionReconciler;
}

/**
 * Replaces a known-stale or unverified cached hierarchy with one independent
 * extraction, within the caller's budget, and re-reads the side samples
 * (lock state, back stack) that described the discarded window.
 */
export class StaleHierarchyRecovery {
  constructor(private readonly deps: StaleHierarchyRecoveryDeps) {}

  private get timer(): Timer {
    return this.deps.timer();
  }
  private get device(): BootedDevice {
    return this.deps.device();
  }
  private get viewHierarchy(): ViewHierarchyInterface {
    return this.deps.viewHierarchy();
  }
  private get deviceStateCollector(): DeviceStateCollectorPort {
    return this.deps.deviceStateCollector();
  }
  /** Recaptures validate against the device's own platform; a watch has no hierarchy path. */
  private get hierarchyPlatform(): AndroidOrIosPlatform {
    return requireAndroidOrIosPlatform(this.device.platform, "Observing the view hierarchy");
  }
  private get platformValidator(): HierarchyPlatformValidator {
    return this.deps.platformValidator();
  }
  private get reconciler(): ActiveWindowAttributionReconciler {
    return this.deps.reconciler();
  }

  /**
   * One bounded hierarchy extraction; derived work and screenshots run later once. The
   * lock state and back stack sampled with the discarded window are re-read against the
   * replacement (#9982), within the same budget and only when the replacement is applied.
   */
  async refreshKnownStaleHierarchy(
    result: ObserveResult,
    foreground: string,
    options: ObserveScreenExecuteOptions | undefined,
    {
      remainingMs,
      sideSamples,
    }: { remainingMs: number; sideSamples: { skipBackStack: boolean; displayId: number } },
  ): Promise<void> {
    const startedAt = this.timer.now();
    const hierarchy = await this.readIndependentHierarchy(
      result.viewHierarchy?.updatedAt,
      options?.signal,
      remainingMs,
      "Known-stale hierarchy refresh",
    );
    if (
      hierarchy?.fresh === true &&
      hasUsableHierarchy(hierarchy) &&
      hierarchy.packageName === foreground &&
      this.platformValidator.validate(this.hierarchyPlatform, hierarchy).valid
    ) {
      this.reconciler.applyRecapturedHierarchy(result, hierarchy);
      this.reconciler.recorrelateActiveWindowToRecapture(result, hierarchy);
      // Earlier back-stack/lock samples describe the discarded window.
      delete result.backStack;
      delete result.deviceLock;
      delete result.deviceLockUnknown;
      await this.resampleAfterStaleWindowRecovery(result, {
        ...sideSamples,
        signal: options?.signal,
        budgetMs: remainingMs - (this.timer.now() - startedAt),
      });
    }
  }

  /**
   * Re-read the lock state and (unless the caller skipped it) the back stack for the
   * window that replaced a stale one. The reads land on a scratch observation and are
   * copied only if they finish inside the budget, so a read that loses the deadline
   * cannot write onto the published result later. A failed or late read leaves the
   * field absent.
   */
  private async resampleAfterStaleWindowRecovery(
    result: ObserveResult,
    options: {
      skipBackStack: boolean;
      displayId: number;
      signal: AbortSignal | undefined;
      budgetMs: number;
    },
  ): Promise<void> {
    const { skipBackStack, displayId, signal, budgetMs } = options;
    if (budgetMs <= 0) {
      return;
    }
    const sampled: ObserveResult = {
      ...result,
      deviceLock: undefined,
      deviceLockUnknown: undefined,
      backStack: undefined,
      errors: undefined,
    };
    const abort = new AbortController();
    const readSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    try {
      await raceWithDeadline(
        Promise.all([
          this.deviceStateCollector.collectDeviceLock(sampled, readSignal),
          skipBackStack
            ? Promise.resolve()
            : this.deviceStateCollector.collectBackStack(
                sampled,
                new NoOpPerformanceTracker(),
                readSignal,
                displayId,
              ),
        ]),
        {
          timer: this.timer,
          timeoutMs: budgetMs,
          signal,
          label: "Stale-window side-sample refresh",
          onTimeout: () => abort.abort(),
        },
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(
        `[StaleHierarchyRecovery] Stale-window side-sample refresh failed: ${describeError(error)}`,
        error,
      );
      return;
    }
    if (sampled.deviceLockUnknown) {
      result.deviceLockUnknown = sampled.deviceLockUnknown;
    }
    if (sampled.deviceLock) {
      result.deviceLock = sampled.deviceLock;
    }
    if (sampled.backStack) {
      result.backStack = sampled.backStack;
    }
    for (const error of sampled.errors ?? []) {
      appendObserveError(result, error);
    }
  }

  /**
   * Explicit-observe verification (#9963). CtrlProxy serves a push-cache entry younger
   * than its serve window without a device read, which `computeFreshness` reports as
   * unverified, so the next action re-observes in full. Replace such a hit with one
   * synchronous extraction of the same window. Only an unverified same-package tree is
   * replaced. Samples taken alongside the cached tree are kept when the new tree itself
   * names the same activity as the kept `activeWindow`. When it names another one or
   * cannot be compared, they are dropped and re-read for the new window with the budget
   * left over (#9982), so the field is only absent if that re-read fails or runs out of
   * time. When the read fails the cached tree stays and its freshness verdict keeps
   * saying it was not verified.
   */
  async verifyCachedAndroidHierarchy(
    result: ObserveResult,
    options: {
      signal?: AbortSignal;
      remainingMs: number;
      eligible: boolean;
      sideSamples: { skipBackStack: boolean; displayId: number };
    },
  ): Promise<void> {
    const cached = result.viewHierarchy;
    if (!cached || !this.needsCachedVerification(cached, options)) {
      return;
    }
    const startedAt = this.timer.now();
    const hierarchy = await this.readIndependentHierarchy(
      cached.updatedAt,
      options.signal,
      options.remainingMs,
      "Cached hierarchy verification",
    );
    if (!hierarchy || !this.isVerifyingReplacement(hierarchy, cached)) {
      return;
    }
    const sameWindow = treeNamesWindow(hierarchy, result.activeWindow);
    this.reconciler.applyRecapturedHierarchy(result, hierarchy);
    if (!sameWindow) {
      // A same-package A->B move between the adb reads and this read would publish
      // B's tree under A's identity. The kept samples cannot be tied to the new tree,
      // so re-correlate exactly as the other recapture paths do, then re-read the
      // samples for the window now being published. Only this path reads the device.
      this.reconciler.recorrelateActiveWindowToRecapture(result, hierarchy);
      delete result.backStack;
      delete result.deviceLock;
      delete result.deviceLockUnknown;
      await this.resampleAfterStaleWindowRecovery(result, {
        ...options.sideSamples,
        signal: options.signal,
        budgetMs: options.remainingMs - (this.timer.now() - startedAt),
      });
    }
  }

  private needsCachedVerification(
    cached: NonNullable<ObserveResult["viewHierarchy"]>,
    options: { eligible: boolean; remainingMs: number },
  ): boolean {
    return (
      options.eligible &&
      this.device.platform === "android" &&
      cached.fresh !== true &&
      hasUsableHierarchy(cached) &&
      options.remainingMs > 0
    );
  }

  private isVerifyingReplacement(
    hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
    cached: NonNullable<ObserveResult["viewHierarchy"]>,
  ): boolean {
    return (
      hierarchy.fresh === true &&
      hasUsableHierarchy(hierarchy) &&
      hierarchy.packageName === cached.packageName &&
      this.platformValidator.validate(this.hierarchyPlatform, hierarchy).valid
    );
  }

  /**
   * One extraction that must not be served from the host cache. A positive, inclusive
   * device floor requests independent extraction without requiring the replacement to
   * have a later timestamp. Failures are logged and yield `undefined`; only an abort
   * propagates.
   */
  private async readIndependentHierarchy(
    updatedAt: number | undefined,
    signal: AbortSignal | undefined,
    remainingMs: number,
    label: string,
  ): Promise<ViewHierarchyResult | undefined> {
    const retryController = new AbortController();
    const retrySignal = signal
      ? AbortSignal.any([signal, retryController.signal])
      : retryController.signal;
    try {
      return await raceWithDeadline(
        // Use the same reader as the initial collection, including its injected
        // client. A fresh action capture can construct a separate resident client.
        () =>
          this.viewHierarchy.getViewHierarchy(
            {},
            {
              perf: new NoOpPerformanceTracker(),
              skipWaitForFresh: true,
              minTimestamp: Math.max(1, updatedAt ?? 1),
              signal: retrySignal,
              timeoutMs: remainingMs,
              requireFreshExtraction: true,
            },
          ),
        {
          timer: this.timer,
          timeoutMs: remainingMs,
          signal,
          label,
          onTimeout: () => retryController.abort(),
        },
      );
    } catch (error) {
      throwIfAborted(signal);
      logger.warn(`[StaleHierarchyRecovery] ${label} failed: ${describeError(error)}`, error);
      return undefined;
    }
  }
}
